'use strict';

/* ==========================================================
   Bitácora · Gestor de tareas por categorías
   Persistencia: localStorage (caché automática) + archivos JSON
   ========================================================== */

const CLAVE_LOCAL = 'bitacora.datos.v1';
const RUTA_SEMILLA = 'data/tareas.json';
const VERSION_DATOS = 1;

const ESTADOS = { pendiente: 'Pendiente', en_curso: 'En curso', completada: 'Completada' };
const PRIORIDADES = { alta: 'Alta', media: 'Media', baja: 'Baja' };
const PESO_PRIORIDAD = { alta: 0, media: 1, baja: 2 };
const TIPOS_EVENTO = ['nota', 'estado', 'progreso', 'creacion', 'edicion'];
const COLORES = ['#c8553d', '#d9a441', '#2a6f6f', '#5b7553', '#7a4e7a', '#3d5a80', '#8c5a3c'];
const NOMBRES_CAMPOS = {
  titulo: 'título', descripcion: 'descripción', categoriaId: 'categoría',
  prioridad: 'prioridad', fechaLimite: 'fecha límite',
};
const TIPOS_JSON = [{ description: 'Archivo JSON de Bitácora', accept: { 'application/json': ['.json'] } }];

const app = {
  datos: null,            // se inicializa al cargar la página
  filtro: { categoriaId: 'todas', texto: '', prioridad: 'todas' },
  archivo: null,          // FileSystemFileHandle (Chrome/Edge)
  nombreArchivo: null,
  cambiosSinArchivo: false,
  tareaActualId: null,
  categoriaActualId: null,
};

let temporizadorAviso = null;

/* ---------- Utilidades ---------- */
function $(sel, ctx = document) { return ctx.querySelector(sel); }
function $$(sel, ctx = document) { return [...ctx.querySelectorAll(sel)]; }

function uid() {
  if (window.crypto && typeof crypto.randomUUID === 'function') {
    try { return crypto.randomUUID(); } catch { /* contexto no seguro */ }
  }
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function ahora() { return new Date().toISOString(); }

function fechaLocalISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function hoyISO() { return fechaLocalISO(new Date()); }

function sumarDias(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return fechaLocalISO(d);
}

function escapar(texto = '') {
  return String(texto).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function formatearFechaCorta(iso) {
  if (!iso) return '';
  const [a, m, d] = iso.split('-').map(Number);
  return new Date(a, m - 1, d).toLocaleDateString('es-CO', { day: 'numeric', month: 'short' });
}

function formatearMarcaTiempo(iso) {
  const fecha = new Date(iso);
  return isNaN(fecha) ? '' : fecha.toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' });
}

// Pequeña inclinación estable por tarea, para el efecto "fichas sobre la mesa"
function giroDesdeId(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
  return ((Math.abs(h) % 5) - 2) * 0.4;
}

function estaVencida(t) {
  return Boolean(t.fechaLimite) && t.estado !== 'completada' && t.fechaLimite < hoyISO();
}
function buscarTarea(id) { return app.datos.tareas.find(t => t.id === id); }
function buscarCategoria(id) { return app.datos.categorias.find(c => c.id === id); }

/* ---------- Modelo de datos ---------- */
function crearEstructuraVacia() {
  return { version: VERSION_DATOS, actualizado: ahora(), categorias: [], tareas: [] };
}

function registrar(tarea, tipo, nota) {
  tarea.seguimiento.unshift({ id: uid(), fecha: ahora(), tipo, nota });
  tarea.actualizada = ahora();
}

// Datos de demostración para la primera vez (si no hay nada guardado ni data/tareas.json)
function datosDeEjemplo() {
  const trabajo = { id: uid(), nombre: 'Trabajo', color: '#2a6f6f', creada: ahora() };
  const hogar = { id: uid(), nombre: 'Hogar', color: '#d9a441', creada: ahora() };

  const crear = (categoria, titulo, descripcion, prioridad, estado, progreso, dias) => {
    const t = {
      id: uid(), categoriaId: categoria.id, titulo, descripcion, prioridad, estado, progreso,
      fechaLimite: dias === null ? '' : sumarDias(dias),
      creada: ahora(), actualizada: ahora(), seguimiento: [],
    };
    registrar(t, 'creacion', 'Tarea creada');
    return t;
  };

  const informe = crear(trabajo, 'Preparar informe mensual', 'Consolidar indicadores y enviarlos al equipo.', 'alta', 'en_curso', 40, 5);
  registrar(informe, 'nota', 'Ya tengo los datos de ventas; falta el resumen.');

  return {
    version: VERSION_DATOS,
    actualizado: ahora(),
    categorias: [trabajo, hogar],
    tareas: [
      informe,
      crear(trabajo, 'Revisar propuesta del cliente', '', 'media', 'pendiente', 0, 10),
      crear(hogar, 'Pagar servicios públicos', '', 'media', 'pendiente', 0, 3),
      crear(hogar, 'Organizar el estudio', 'Clasificar papeles y donar lo que no se usa.', 'baja', 'completada', 100, null),
    ],
  };
}

// Valida y completa cualquier JSON cargado para que la app nunca se rompa
function normalizar(crudo) {
  if (!crudo || typeof crudo !== 'object') throw new Error('JSON sin estructura válida');

  const categorias = (Array.isArray(crudo.categorias) ? crudo.categorias : [])
    .filter(c => c && c.nombre)
    .map((c, i) => ({
      id: String(c.id || uid()),
      nombre: String(c.nombre).slice(0, 40),
      color: /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : COLORES[i % COLORES.length],
      creada: c.creada || ahora(),
    }));

  const idsCategorias = new Set(categorias.map(c => c.id));
  let categoriaHuerfana = null;

  const tareas = (Array.isArray(crudo.tareas) ? crudo.tareas : [])
    .filter(t => t && t.titulo)
    .map(t => {
      let categoriaId = String(t.categoriaId ?? '');
      if (!idsCategorias.has(categoriaId)) {
        if (!categoriaHuerfana) {
          categoriaHuerfana = { id: uid(), nombre: 'Sin categoría', color: '#8c5a3c', creada: ahora() };
          categorias.push(categoriaHuerfana);
          idsCategorias.add(categoriaHuerfana.id);
        }
        categoriaId = categoriaHuerfana.id;
      }
      return {
        id: String(t.id || uid()),
        categoriaId,
        titulo: String(t.titulo).slice(0, 120),
        descripcion: String(t.descripcion || '').slice(0, 1000),
        prioridad: PRIORIDADES[t.prioridad] ? t.prioridad : 'media',
        estado: ESTADOS[t.estado] ? t.estado : 'pendiente',
        progreso: Math.min(100, Math.max(0, Math.round(Number(t.progreso) || 0))),
        fechaLimite: /^\d{4}-\d{2}-\d{2}$/.test(t.fechaLimite || '') ? t.fechaLimite : '',
        creada: t.creada || ahora(),
        actualizada: t.actualizada || t.creada || ahora(),
        seguimiento: (Array.isArray(t.seguimiento) ? t.seguimiento : [])
          .filter(s => s && s.nota)
          .map(s => ({
            id: String(s.id || uid()),
            fecha: s.fecha || ahora(),
            tipo: TIPOS_EVENTO.includes(s.tipo) ? s.tipo : 'nota',
            nota: String(s.nota).slice(0, 300),
          })),
      };
    });

  return { version: VERSION_DATOS, actualizado: crudo.actualizado || ahora(), categorias, tareas };
}

/* ---------- Persistencia ---------- */
function persistir({ marcarCambios = true } = {}) {
  app.datos.actualizado = ahora();
  try {
    localStorage.setItem(CLAVE_LOCAL, JSON.stringify(app.datos));
  } catch {
    avisar('No se pudo guardar en el navegador. Exporta tu JSON.', 'error');
  }
  if (marcarCambios) app.cambiosSinArchivo = true;
  pintarEstadoArchivo();
}

function leerLocal() {
  try {
    const texto = localStorage.getItem(CLAVE_LOCAL);
    return texto ? normalizar(JSON.parse(texto)) : null;
  } catch {
    return null;
  }
}

async function cargarSemilla() {
  try {
    const respuesta = await fetch(RUTA_SEMILLA, { cache: 'no-store' });
    return respuesta.ok ? normalizar(await respuesta.json()) : null;
  } catch {
    return null; // p. ej. al abrir con file:// o si el archivo no existe
  }
}

async function cargarInicial() {
  const local = leerLocal();
  if (local) {
    app.datos = local;
    return;
  }
  app.datos = (await cargarSemilla()) || datosDeEjemplo();
  persistir({ marcarCambios: false });
}

function importarTexto(texto, nombre) {
  let datos;
  try {
    datos = normalizar(JSON.parse(texto));
  } catch {
    avisar('El archivo no es un JSON válido de Bitácora.', 'error');
    return false;
  }
  if (app.cambiosSinArchivo &&
      !confirm(`Tienes cambios sin guardar en archivo. ¿Reemplazarlos con «${nombre}»?`)) {
    return false;
  }
  app.datos = datos;
  app.nombreArchivo = nombre;
  app.archivo = null;
  app.filtro.categoriaId = 'todas';
  app.cambiosSinArchivo = false;
  persistir({ marcarCambios: false });
  renderizar();
  avisar(`«${nombre}» cargado: ${datos.tareas.length} tareas.`);
  return true;
}

async function abrirArchivo() {
  if (typeof window.showOpenFilePicker !== 'function') {
    $('#input-archivo').click();
    return;
  }
  try {
    const [manejador] = await window.showOpenFilePicker({ types: TIPOS_JSON, multiple: false });
    const archivo = await manejador.getFile();
    if (importarTexto(await archivo.text(), archivo.name)) app.archivo = manejador;
  } catch (e) {
    if (e.name !== 'AbortError') avisar('No se pudo abrir el archivo.', 'error');
  }
}

async function guardarArchivo() {
  app.datos.actualizado = ahora();
  const texto = JSON.stringify(app.datos, null, 2);

  if (typeof window.showSaveFilePicker !== 'function') {
    descargar(texto);
    return;
  }
  try {
    if (!app.archivo) {
      app.archivo = await window.showSaveFilePicker({
        suggestedName: app.nombreArchivo || 'tareas.json',
        types: TIPOS_JSON,
      });
    }
    const escritor = await app.archivo.createWritable();
    await escritor.write(texto);
    await escritor.close();
    app.nombreArchivo = app.archivo.name;
    marcarGuardado();
  } catch (e) {
    if (e.name === 'AbortError') return;
    app.archivo = null;
    avisar('No se pudo escribir el archivo; se descargará una copia.', 'error');
    descargar(texto);
  }
}

function descargar(texto) {
  const url = URL.createObjectURL(new Blob([texto], { type: 'application/json' }));
  const enlace = document.createElement('a');
  enlace.href = url;
  enlace.download = app.nombreArchivo || 'tareas.json';
  document.body.append(enlace);
  enlace.click();
  enlace.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  marcarGuardado();
}

function marcarGuardado() {
  app.cambiosSinArchivo = false;
  persistir({ marcarCambios: false });
  avisar(`Guardado en «${app.nombreArchivo || 'tareas.json'}»`);
}

/* ---------- Render ---------- */
function renderizar() {
  pintarCategorias();
  pintarEstadisticas();
  pintarTablero();
  pintarEstadoArchivo();
}

function pintarEstadoArchivo() {
  const el = $('#estado-archivo');
  if (!el) return;
  const base = app.nombreArchivo ? `«${app.nombreArchivo}»` : 'Guardado local';
  el.textContent = app.cambiosSinArchivo ? `${base} · sin exportar` : base;
  el.classList.toggle('pendiente', app.cambiosSinArchivo);
}

function pintarCategorias() {
  const { categorias, tareas } = app.datos;
  const activa = app.filtro.categoriaId;
  const items = [`
    <li>
      <button type="button" class="pestana ${activa === 'todas' ? 'activa' : ''}" data-categoria="todas" style="--color-cat: var(--tinta)">
        <span class="pestana-nombre">Todas</span><span class="pestana-num">${tareas.length}</span>
      </button>
    </li>`];

  for (const c of categorias) {
    const total = tareas.filter(t => t.categoriaId === c.id).length;
    items.push(`
      <li class="pestana-fila">
        <button type="button" class="pestana ${activa === c.id ? 'activa' : ''}" data-categoria="${escapar(c.id)}" style="--color-cat:${c.color}">
          <span class="pestana-nombre">${escapar(c.nombre)}</span><span class="pestana-num">${total}</span>
        </button>
        <button type="button" class="pestana-editar" data-editar-categoria="${escapar(c.id)}" aria-label="Editar ${escapar(c.nombre)}" title="Editar">✎</button>
      </li>`);
  }
  if (!categorias.length) items.push('<li class="vacio-mini">Crea tu primera categoría con el botón +</li>');
  $('#lista-categorias').innerHTML = items.join('');
}

function pintarEstadisticas() {
  const ts = app.filtro.categoriaId === 'todas'
    ? app.datos.tareas
    : app.datos.tareas.filter(t => t.categoriaId === app.filtro.categoriaId);
  const total = ts.length;
  const enCurso = ts.filter(t => t.estado === 'en_curso').length;
  const hechas = ts.filter(t => t.estado === 'completada').length;
  const vencidas = ts.filter(estaVencida).length;
  const avance = total ? Math.round(ts.reduce((suma, t) => suma + t.progreso, 0) / total) : 0;

  const dato = (valor, etiqueta, clase = '') =>
    `<div class="dato ${clase}"><span class="dato-valor">${valor}</span><span class="dato-etiqueta">${etiqueta}</span></div>`;

  $('#estadisticas').innerHTML = [
    dato(total, 'Tareas'),
    dato(enCurso, 'En curso'),
    dato(hechas, 'Completadas'),
    dato(vencidas, 'Vencidas', vencidas ? 'alerta' : ''),
    `<div class="dato dato-medidor">
       <div class="medidor" style="--p:${avance}" aria-hidden="true"></div>
       <div class="dato-texto"><span class="dato-valor">${avance}%</span><span class="dato-etiqueta">Avance medio</span></div>
     </div>`,
  ].join('');
}

function tareasFiltradas() {
  const { categoriaId, texto, prioridad } = app.filtro;
  const q = texto.trim().toLowerCase();
  return app.datos.tareas.filter(t =>
    (categoriaId === 'todas' || t.categoriaId === categoriaId) &&
    (prioridad === 'todas' || t.prioridad === prioridad) &&
    (!q || t.titulo.toLowerCase().includes(q) || t.descripcion.toLowerCase().includes(q))
  );
}

function pintarTablero() {
  const categoria = buscarCategoria(app.filtro.categoriaId);
  $('#titulo-vista').textContent = categoria ? categoria.nombre : 'Todas las tareas';

  const tareas = tareasFiltradas().sort((a, b) =>
    PESO_PRIORIDAD[a.prioridad] - PESO_PRIORIDAD[b.prioridad] ||
    (a.fechaLimite || '9999').localeCompare(b.fechaLimite || '9999') ||
    b.actualizada.localeCompare(a.actualizada)
  );

  for (const estado of Object.keys(ESTADOS)) {
    const grupo = tareas.filter(t => t.estado === estado);
    $(`[data-contador="${estado}"]`).textContent = grupo.length;
    $(`.columna-cuerpo[data-estado="${estado}"]`).innerHTML = grupo.length
      ? grupo.map(fichaHTML).join('')
      : `<p class="vacio">${estado === 'completada' ? 'Nada archivado aún' : 'Sin tareas aquí'}</p>`;
  }
}

function fichaHTML(t) {
  const categoria = buscarCategoria(t.categoriaId);
  const color = categoria ? categoria.color : '#8c5a3c';
  const vencida = estaVencida(t);
  const notas = t.seguimiento.filter(s => s.tipo === 'nota').length;

  return `
    <article class="ficha prioridad-${t.prioridad} ${t.estado === 'completada' ? 'hecha' : ''}"
             draggable="true" tabindex="0" data-id="${escapar(t.id)}"
             style="--color-cat:${color};--giro:${giroDesdeId(t.id)}deg"
             aria-label="${escapar(t.titulo)}">
      <span class="ficha-cinta">${escapar(categoria ? categoria.nombre : '')}</span>
      <h4 class="ficha-titulo">${escapar(t.titulo)}</h4>
      ${t.descripcion ? `<p class="ficha-desc">${escapar(t.descripcion)}</p>` : ''}
      <div class="ficha-progreso" role="progressbar" aria-valuenow="${t.progreso}" aria-valuemin="0" aria-valuemax="100">
        <span style="width:${t.progreso}%"></span>
      </div>
      <footer class="ficha-pie">
        <span class="chip chip-${t.prioridad}">${PRIORIDADES[t.prioridad]}</span>
        ${t.fechaLimite ? `<span class="fecha ${vencida ? 'vencida' : ''}">${vencida ? 'Venció ' : ''}${formatearFechaCorta(t.fechaLimite)}</span>` : ''}
        <span class="notas" title="Notas de seguimiento">✎ ${notas}</span>
      </footer>
      ${t.estado === 'completada' ? '<span class="sello">Completada</span>' : ''}
      ${vencida ? '<span class="sello sello-rojo">Vencida</span>' : ''}
    </article>`;
}

function pintarLineaTiempo(tarea) {
  $('#linea-tiempo').innerHTML = tarea.seguimiento.length
    ? tarea.seguimiento.map(s => `
        <li class="evento evento-${s.tipo}">
          <time datetime="${escapar(s.fecha)}">${formatearMarcaTiempo(s.fecha)}</time>
          <p>${escapar(s.nota)}</p>
        </li>`).join('')
    : '<li class="vacio">Sin registros todavía.</li>';
}

/* ---------- Tareas ---------- */
function abrirDialogoTarea(id = null) {
  if (!app.datos.categorias.length) {
    abrirDialogoCategoria();
    avisar('Primero crea una categoría para tus tareas.');
    return;
  }
  const form = $('#form-tarea');
  const f = form.elements;
  const tarea = id ? buscarTarea(id) : null;
  app.tareaActualId = tarea ? tarea.id : null;

  form.reset();
  f.categoriaId.innerHTML = app.datos.categorias
    .map(c => `<option value="${escapar(c.id)}">${escapar(c.nombre)}</option>`).join('');

  $('#titulo-dialogo-tarea').textContent = tarea ? 'Ficha de tarea' : 'Nueva tarea';
  f.titulo.value = tarea ? tarea.titulo : '';
  f.descripcion.value = tarea ? tarea.descripcion : '';
  f.categoriaId.value = tarea
    ? tarea.categoriaId
    : (app.filtro.categoriaId !== 'todas' ? app.filtro.categoriaId : app.datos.categorias[0].id);
  f.prioridad.value = tarea ? tarea.prioridad : 'media';
  f.estado.value = tarea ? tarea.estado : 'pendiente';
  f.fechaLimite.value = tarea ? tarea.fechaLimite : '';
  f.progreso.value = tarea ? tarea.progreso : 0;
  $('#salida-progreso').textContent = `${f.progreso.value}%`;

  $('#seccion-seguimiento').hidden = !tarea;
  $('#btn-eliminar-tarea').hidden = !tarea;
  if (tarea) pintarLineaTiempo(tarea);

  $('#dialogo-tarea').showModal();
  f.titulo.focus();
}

function guardarTarea(evento) {
  evento.preventDefault();
  const f = $('#form-tarea').elements;
  const valores = {
    titulo: f.titulo.value.trim(),
    descripcion: f.descripcion.value.trim(),
    categoriaId: f.categoriaId.value,
    prioridad: f.prioridad.value,
    estado: f.estado.value,
    fechaLimite: f.fechaLimite.value,
    progreso: Number(f.progreso.value),
  };
  if (!valores.titulo) {
    f.titulo.reportValidity();
    return;
  }
  if (valores.estado === 'completada') valores.progreso = 100;

  if (app.tareaActualId) {
    const t = buscarTarea(app.tareaActualId);
    if (t.estado !== valores.estado) registrar(t, 'estado', `${ESTADOS[t.estado]} → ${ESTADOS[valores.estado]}`);
    if (t.progreso !== valores.progreso) registrar(t, 'progreso', `Progreso ${t.progreso}% → ${valores.progreso}%`);
    const editados = Object.keys(NOMBRES_CAMPOS).filter(k => t[k] !== valores[k]);
    if (editados.length) registrar(t, 'edicion', `Editado: ${editados.map(k => NOMBRES_CAMPOS[k]).join(', ')}`);
    Object.assign(t, valores, { actualizada: ahora() });
    avisar('Tarea actualizada');
  } else {
    const t = { id: uid(), ...valores, creada: ahora(), actualizada: ahora(), seguimiento: [] };
    registrar(t, 'creacion', 'Tarea creada');
    app.datos.tareas.push(t);
    avisar('Tarea archivada');
  }

  persistir();
  renderizar();
  $('#dialogo-tarea').close();
}

function cambiarEstado(id, nuevoEstado) {
  const t = buscarTarea(id);
  if (!t || t.estado === nuevoEstado || !ESTADOS[nuevoEstado]) return;
  registrar(t, 'estado', `${ESTADOS[t.estado]} → ${ESTADOS[nuevoEstado]}`);
  t.estado = nuevoEstado;
  if (nuevoEstado === 'completada') t.progreso = 100;
  persistir();
  renderizar();
}

function agregarNota() {
  const input = $('#input-nota');
  const texto = input.value.trim();
  const tarea = buscarTarea(app.tareaActualId);
  if (!texto || !tarea) return;
  registrar(tarea, 'nota', texto);
  input.value = '';
  persistir();
  pintarLineaTiempo(tarea);
  pintarTablero();
}

function eliminarTarea() {
  const tarea = buscarTarea(app.tareaActualId);
  if (!tarea || !confirm(`¿Eliminar «${tarea.titulo}»? Esta acción no se puede deshacer.`)) return;
  app.datos.tareas = app.datos.tareas.filter(t => t.id !== tarea.id);
  persistir();
  renderizar();
  $('#dialogo-tarea').close();
  avisar('Tarea eliminada');
}

/* ---------- Categorías ---------- */
function abrirDialogoCategoria(id = null) {
  const categoria = id ? buscarCategoria(id) : null;
  app.categoriaActualId = categoria ? categoria.id : null;

  const form = $('#form-categoria');
  form.reset();
  form.elements.nombre.setCustomValidity('');
  $('#titulo-dialogo-categoria').textContent = categoria ? 'Editar categoría' : 'Nueva categoría';
  form.elements.nombre.value = categoria ? categoria.nombre : '';

  const colorActual = categoria ? categoria.color : COLORES[app.datos.categorias.length % COLORES.length];
  const paleta = COLORES.includes(colorActual) ? COLORES : [...COLORES, colorActual];
  $('#opciones-color').innerHTML = paleta.map(color => `
    <label class="muestra" style="--muestra:${color}">
      <input type="radio" name="color" value="${color}" ${color === colorActual ? 'checked' : ''}>
      <span class="sr-only">Color ${color}</span>
    </label>`).join('');

  $('#btn-eliminar-categoria').hidden = !categoria;
  $('#dialogo-categoria').showModal();
  form.elements.nombre.focus();
}

function guardarCategoria(evento) {
  evento.preventDefault();
  const f = $('#form-categoria').elements;
  const nombre = f.nombre.value.trim();
  const marcado = $('#form-categoria input[name="color"]:checked');
  const color = marcado ? marcado.value : COLORES[0];
  if (!nombre) {
    f.nombre.reportValidity();
    return;
  }

  const duplicada = app.datos.categorias.some(c =>
    c.nombre.toLowerCase() === nombre.toLowerCase() && c.id !== app.categoriaActualId);
  if (duplicada) {
    f.nombre.setCustomValidity('Ya existe una categoría con ese nombre.');
    f.nombre.reportValidity();
    return;
  }

  if (app.categoriaActualId) {
    Object.assign(buscarCategoria(app.categoriaActualId), { nombre, color });
    avisar('Categoría actualizada');
  } else {
    const nueva = { id: uid(), nombre, color, creada: ahora() };
    app.datos.categorias.push(nueva);
    app.filtro.categoriaId = nueva.id;
    avisar(`Carpeta «${nombre}» creada`);
  }
  persistir();
  renderizar();
  $('#dialogo-categoria').close();
}

function eliminarCategoria() {
  const categoria = buscarCategoria(app.categoriaActualId);
  if (!categoria) return;
  const total = app.datos.tareas.filter(t => t.categoriaId === categoria.id).length;
  const mensaje = total
    ? `«${categoria.nombre}» tiene ${total} tarea(s) que también se eliminarán. ¿Continuar?`
    : `¿Eliminar la categoría «${categoria.nombre}»?`;
  if (!confirm(mensaje)) return;

  app.datos.categorias = app.datos.categorias.filter(c => c.id !== categoria.id);
  app.datos.tareas = app.datos.tareas.filter(t => t.categoriaId !== categoria.id);
  if (app.filtro.categoriaId === categoria.id) app.filtro.categoriaId = 'todas';
  persistir();
  renderizar();
  $('#dialogo-categoria').close();
  avisar('Categoría eliminada');
}

/* ---------- Avisos ---------- */
function soportaPopover(el) { return typeof el.showPopover === 'function'; }

function mostrarAviso(el, visible) {
  if (soportaPopover(el)) {
    try { visible ? el.showPopover() : el.hidePopover(); } catch { /* ya estaba en ese estado */ }
  } else {
    el.hidden = !visible;
  }
}

function avisar(texto, tipo = 'ok') {
  const el = $('#aviso');
  if (!el) return;
  el.textContent = texto;
  el.className = `aviso aviso-${tipo}`;
  mostrarAviso(el, false);
  mostrarAviso(el, true); // reabrir lo pone por encima de cualquier diálogo
  clearTimeout(temporizadorAviso);
  temporizadorAviso = setTimeout(() => mostrarAviso(el, false), 2800);
}

/* ---------- Eventos ---------- */
function conectarEventos() {
  $('#btn-nueva-tarea').addEventListener('click', () => abrirDialogoTarea());
  $('#btn-nueva-categoria').addEventListener('click', () => abrirDialogoCategoria());
  $('#btn-abrir').addEventListener('click', abrirArchivo);
  $('#btn-guardar').addEventListener('click', guardarArchivo);

  $('#input-archivo').addEventListener('change', async e => {
    const archivo = e.target.files[0];
    if (archivo) importarTexto(await archivo.text(), archivo.name);
    e.target.value = '';
  });

  $('#lista-categorias').addEventListener('click', e => {
    const editar = e.target.closest('[data-editar-categoria]');
    if (editar) {
      abrirDialogoCategoria(editar.dataset.editarCategoria);
      return;
    }
    const pestana = e.target.closest('[data-categoria]');
    if (pestana) {
      app.filtro.categoriaId = pestana.dataset.categoria;
      renderizar();
    }
  });

  $('#buscar').addEventListener('input', e => { app.filtro.texto = e.target.value; pintarTablero(); });
  $('#filtro-prioridad').addEventListener('change', e => { app.filtro.prioridad = e.target.value; pintarTablero(); });

  // Tablero: abrir fichas y arrastrar entre columnas
  const tablero = $('.tablero');
  tablero.addEventListener('click', e => {
    const ficha = e.target.closest('.ficha');
    if (ficha) abrirDialogoTarea(ficha.dataset.id);
  });
  tablero.addEventListener('keydown', e => {
    const ficha = e.target.closest('.ficha');
    if (ficha && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      abrirDialogoTarea(ficha.dataset.id);
    }
  });
  tablero.addEventListener('dragstart', e => {
    const ficha = e.target.closest('.ficha');
    if (!ficha) return;
    e.dataTransfer.setData('text/plain', ficha.dataset.id);
    e.dataTransfer.effectAllowed = 'move';
    ficha.classList.add('arrastrando');
  });
  tablero.addEventListener('dragend', e => {
    const ficha = e.target.closest && e.target.closest('.ficha');
    if (ficha) ficha.classList.remove('arrastrando');
  });

  $$('.columna-cuerpo').forEach(columna => {
    columna.addEventListener('dragover', e => { e.preventDefault(); columna.classList.add('sobre'); });
    columna.addEventListener('dragleave', e => {
      if (!columna.contains(e.relatedTarget)) columna.classList.remove('sobre');
    });
    columna.addEventListener('drop', e => {
      e.preventDefault();
      columna.classList.remove('sobre');
      const id = e.dataTransfer.getData('text/plain');
      if (id) cambiarEstado(id, columna.dataset.estado);
    });
  });

  // Diálogos
  $('#form-tarea').addEventListener('submit', guardarTarea);
  $('#form-categoria').addEventListener('submit', guardarCategoria);
  $('#form-categoria').elements.nombre.addEventListener('input', e => e.target.setCustomValidity(''));
  $('#form-tarea').elements.progreso.addEventListener('input', e => {
    $('#salida-progreso').textContent = `${e.target.value}%`;
  });
  $('#btn-agregar-nota').addEventListener('click', agregarNota);
  $('#input-nota').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); agregarNota(); }
  });
  $('#btn-eliminar-tarea').addEventListener('click', eliminarTarea);
  $('#btn-eliminar-categoria').addEventListener('click', eliminarCategoria);
  $$('[data-cerrar]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
  $$('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));

  // Atajos de teclado
  document.addEventListener('keydown', e => {
    const tecla = (e.key || '').toLowerCase(); // el autocompletado puede enviar key vacío
    const activo = document.activeElement;
    const escribiendo = activo && /INPUT|TEXTAREA|SELECT/.test(activo.tagName);
    if ((e.ctrlKey || e.metaKey) && tecla === 's') {
      e.preventDefault();
      guardarArchivo();
    } else if (tecla === 'n' && !e.ctrlKey && !e.metaKey && !e.altKey && !escribiendo && !$('dialog[open]')) {
      e.preventDefault();
      abrirDialogoTarea();
    }
  });

  // Sincroniza si la app está abierta en otra pestaña
  window.addEventListener('storage', e => {
    if (e.key !== CLAVE_LOCAL) return;
    const datos = leerLocal();
    if (datos) {
      app.datos = datos;
      renderizar();
    }
  });
}

/* ---------- Inicio ---------- */
async function iniciar() {
  const aviso = $('#aviso');
  if (aviso && !soportaPopover(aviso)) aviso.hidden = true;

  try {
    app.datos = crearEstructuraVacia();
    $('#fecha-hoy').textContent = new Date().toLocaleDateString('es-CO', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
    conectarEventos();
    renderizar();          // pinta algo de inmediato
    await cargarInicial(); // luego carga los datos reales
    renderizar();
  } catch (error) {
    console.error(error);
    avisar(`Error al iniciar: ${error.message}`, 'error');
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', iniciar);
} else {
  iniciar();
}