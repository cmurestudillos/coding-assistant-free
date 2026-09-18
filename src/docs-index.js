const axios = require('axios');
const cheerio = require('cheerio');
const { docsSources } = require('./docs-sources');
const { createTurndown, truncate, EXACT_REFERENCE_HEADINGS } = require('./markdown');

// Índice local de documentación: paquetes de DevDocs (devdocs.io) descargados una vez,
// troceados por secciones y guardados en SQLite con búsqueda de texto completo (FTS5).
// Así la búsqueda funciona sin conexión y no depende de que cambie el HTML de las webs.

const CATALOG_URL = 'https://devdocs.io/docs.json';
const DOCUMENTS_URL = 'https://documents.devdocs.io';
const CATALOG_TTL = 60 * 60 * 1000; // 1 hora
const CHUNK_CHARS = 1800; // Tamaño objetivo de cada fragmento (unos 450 tokens)
const MAX_BLOCK_CHARS = 4000; // Un bloque indivisible (p. ej. un ejemplo de código) nunca pasa de aquí
const PAGES_PER_BATCH = 50; // Páginas por transacción: transacciones cortas para no bloquear la base de datos
const SEARCH_CANDIDATES = 40;
const DOWNLOAD_IDLE_TIMEOUT = 20000; // Sin recibir datos durante este tiempo → reintentar
const DOWNLOAD_ATTEMPTS = 3;
const EMBED_BATCH = 32; // Fragmentos por llamada a Ollama (~7 ms por fragmento con GPU)
// Constante de Reciprocal Rank Fusion. El valor clásico (60) puntúa tan plano que un fragmento
// mediocre en las dos listas gana al mejor de una sola; con 10 cuentan más las primeras posiciones.
// Elegido evaluando 24 consultas (nombres de API y descripciones) sobre la documentación de JavaScript
const RRF_K = 10;

// Secciones de MDN que no aportan al modelo
const SKIPPED_SECTION_IDS = new Set(['try_it', 'browser_compatibility', 'specifications', 'see_also']);

class DocsIndex {
  // db: la misma conexión sqlite3 que usa Database. Con una segunda conexión, las esperas
  // por bloqueo ocupan hilos del pool de libuv (compartido por todas las consultas) y la
  // instalación y el guardado de mensajes pueden bloquearse mutuamente.
  // databaseReady: se resuelve cuando Database ha creado su esquema
  // embedder (opcional): AIEngine, para la búsqueda semántica con embeddings de Ollama
  constructor(db, databaseReady = Promise.resolve(), embedder = null) {
    this.db = db;
    this.embedder = embedder;
    this.turndown = createTurndown();
    this.catalog = null;
    this.catalogFetchedAt = 0;
    this.installing = null; // Clave de la tecnología que se está instalando
    this.vectorCache = new Map(); // tech → { ids, matrix, dim }: vectores cargados en memoria
    this.ready = this.initialize(databaseReady);
  }

  async initialize(databaseReady) {
    await databaseReady;

    await this.run(`
      CREATE TABLE IF NOT EXISTS docs_packs (
        tech TEXT PRIMARY KEY,
        slug TEXT,
        name TEXT,
        release TEXT,
        mtime INTEGER,
        pages INTEGER,
        chunks INTEGER,
        installed_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await this.run(`
      CREATE TABLE IF NOT EXISTS docs_chunks (
        id INTEGER PRIMARY KEY,
        tech TEXT,
        path TEXT,
        page_title TEXT,
        position INTEGER,
        names TEXT,
        heading TEXT,
        content TEXT
      )
    `);
    await this.run('CREATE INDEX IF NOT EXISTS idx_chunks_page ON docs_chunks(tech, path, position)');
    // names: nombres de API de DevDocs (p. ej. "Array.map"), el campo con más peso en la búsqueda
    await this.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
        names, heading, content,
        content = 'docs_chunks', content_rowid = 'id',
        tokenize = 'porter unicode61'
      )
    `);

    // Embeddings de cada fragmento (Float32Array normalizado guardado como BLOB)
    await this.run('CREATE TABLE IF NOT EXISTS docs_vectors (chunk_id INTEGER PRIMARY KEY, vector BLOB)');
    // Modelo con el que se generaron los embeddings del paquete (NULL = sin búsqueda semántica).
    // Columna añadida en la Fase 3: las bases de datos anteriores no la tienen
    const packColumns = await this.all('PRAGMA table_info(docs_packs)');
    if (!packColumns.some(column => column.name === 'embed_model')) {
      await this.run('ALTER TABLE docs_packs ADD COLUMN embed_model TEXT');
    }

    // Restos de una instalación interrumpida (p. ej. se cerró la app a mitad)
    const orphans = await this.all(
      'SELECT DISTINCT tech FROM docs_chunks WHERE tech NOT IN (SELECT tech FROM docs_packs)'
    );
    for (const { tech } of orphans) {
      await this.deleteTechChunks(tech);
    }
    await this.run(
      `DELETE FROM docs_vectors WHERE chunk_id NOT IN (SELECT id FROM docs_chunks)
       OR chunk_id IN (SELECT c.id FROM docs_chunks c JOIN docs_packs p ON p.tech = c.tech WHERE p.embed_model IS NULL)`
    );
  }

  // --- Catálogo y paquetes ---

  async getCatalog() {
    if (!this.catalog || Date.now() - this.catalogFetchedAt > CATALOG_TTL) {
      const { data } = await axios.get(CATALOG_URL, { timeout: 15000 });
      this.catalog = data;
      this.catalogFetchedAt = Date.now();
    }
    return this.catalog;
  }

  // El catálogo lista primero la versión más reciente de cada documentación
  findPackage(catalog, devdocsName) {
    return catalog.find(doc => doc.name === devdocsName) || null;
  }

  // Estado de cada paquete para la interfaz. online = false si no se pudo leer el catálogo
  async listPacks() {
    await this.ready;

    const installed = {};
    for (const row of await this.all('SELECT * FROM docs_packs')) {
      installed[row.tech] = row;
    }

    let catalog = null;
    try {
      catalog = await this.getCatalog();
    } catch (error) {
      console.error('No se pudo leer el catálogo de DevDocs:', error.code || error.message);
    }

    const packs = Object.entries(docsSources)
      .filter(([, source]) => source.devdocs)
      .map(([key, source]) => {
        const pkg = catalog ? this.findPackage(catalog, source.devdocs) : null;
        const pack = installed[key];

        return {
          key,
          name: source.devdocsTitle || source.name,
          available: Boolean(pkg),
          release: pkg ? pkg.release || pkg.version || '' : '',
          size: pkg ? pkg.db_size : 0,
          installing: this.installing === key,
          installed: pack
            ? {
                release: pack.release,
                pages: pack.pages,
                chunks: pack.chunks,
                installedAt: pack.installed_at,
                semantic: Boolean(pack.embed_model),
              }
            : null,
          updateAvailable: Boolean(pack && pkg && pkg.mtime > pack.mtime),
        };
      });

    // embedAvailable: el modelo de embeddings está instalado en Ollama
    return { online: Boolean(catalog), embedAvailable: await this.canEmbed(), packs };
  }

  // Descarga e indexa (o actualiza) la documentación de una tecnología.
  // onProgress({ phase: 'download' | 'index', percent })
  async install(key, onProgress = () => {}) {
    const source = docsSources[key];
    if (!source || !source.devdocs) {
      throw new Error(`No hay documentación descargable para "${key}"`);
    }
    if (this.installing) {
      throw new Error(`Ya se está descargando ${docsSources[this.installing].name}. Espera a que termine.`);
    }

    this.installing = key;

    try {
      await this.ready;

      const pkg = this.findPackage(await this.getCatalog(), source.devdocs);
      if (!pkg) {
        throw new Error(`${source.devdocs} no está disponible en DevDocs`);
      }

      onProgress({ phase: 'download', percent: 0 });
      const baseUrl = `${DOCUMENTS_URL}/${pkg.slug}`;
      const index = await this.download(`${baseUrl}/index.json?${pkg.mtime}`);
      const pages = await this.download(`${baseUrl}/db.json?${pkg.mtime}`, event => {
        const total = event.total || pkg.db_size;
        onProgress({ phase: 'download', percent: Math.min(99, Math.round((event.loaded / total) * 100)) });
      });

      // Sustituir la versión anterior, si la hay
      await this.run('DELETE FROM docs_packs WHERE tech = ?', [key]);
      await this.deleteTechChunks(key);

      const entries = this.groupEntries(index.entries || []);
      const paths = Object.keys(pages);
      let chunkCount = 0;

      for (let start = 0; start < paths.length; start += PAGES_PER_BATCH) {
        const batch = paths.slice(start, start + PAGES_PER_BATCH);

        // Trocear primero, fuera de la transacción (es lo lento)
        const batchChunks = [];
        for (const path of batch) {
          batchChunks.push([path, this.chunkPage(pages[path], entries.get(path))]);
          // Ceder el hilo principal entre páginas para que la app siga respondiendo
          await new Promise(resolve => setImmediate(resolve));
        }

        // Insertar en una transacción corta. La conexión es compartida: si mientras tanto se
        // guarda un mensaje, entra en esta transacción. Por eso se confirma siempre (nunca
        // ROLLBACK, que lo perdería); si algo falla, el catch de abajo borra los fragmentos
        await this.run('BEGIN');
        try {
          for (const [path, chunks] of batchChunks) {
            for (const chunk of chunks) {
              await this.insertChunk(key, path, chunk);
            }
            chunkCount += chunks.length;
          }
        } finally {
          await this.run('COMMIT');
        }

        onProgress({ phase: 'index', percent: Math.round(((start + batch.length) / paths.length) * 100) });
      }

      await this.run(
        'INSERT INTO docs_packs (tech, slug, name, release, mtime, pages, chunks) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [key, pkg.slug, pkg.name, pkg.release || pkg.version || '', pkg.mtime, paths.length, chunkCount]
      );

      // Búsqueda semántica, si el modelo de embeddings está instalado. Si falla, el paquete
      // ya está instalado y funciona con la búsqueda por texto
      let semantic = false;
      if (await this.canEmbed()) {
        try {
          await this.embedChunks(key, onProgress);
          semantic = true;
        } catch (error) {
          console.error(`No se pudieron generar los embeddings de ${key}:`, error.message);
        }
      }

      return { pages: paths.length, chunks: chunkCount, release: pkg.release || '', semantic };
    } catch (error) {
      await this.deleteTechChunks(key).catch(() => {});
      throw error;
    } finally {
      this.installing = null;
    }
  }

  // --- Búsqueda semántica (embeddings) ---

  async canEmbed() {
    if (!this.embedder) {
      return false;
    }
    try {
      return await this.embedder.hasEmbedModel();
    } catch (_error) {
      return false;
    }
  }

  // Genera los embeddings de un paquete ya instalado (p. ej. uno instalado antes de tener el modelo)
  async embedPack(key, onProgress = () => {}) {
    if (this.installing) {
      throw new Error(`Ya se está procesando ${docsSources[this.installing].name}. Espera a que termine.`);
    }
    if (!(await this.canEmbed())) {
      throw new Error(`Falta el modelo ${this.embedder ? this.embedder.embedModel : 'de embeddings'} en Ollama`);
    }

    this.installing = key;
    try {
      await this.ready;
      await this.embedChunks(key, onProgress);
    } finally {
      this.installing = null;
    }
  }

  async embedChunks(key, onProgress) {
    await this.deleteTechVectors(key);
    await this.run('UPDATE docs_packs SET embed_model = NULL WHERE tech = ?', [key]);

    const chunks = await this.all('SELECT id, heading, content FROM docs_chunks WHERE tech = ? ORDER BY id', [key]);
    onProgress({ phase: 'embed', percent: 0 });

    try {
      for (let start = 0; start < chunks.length; start += EMBED_BATCH) {
        const batch = chunks.slice(start, start + EMBED_BATCH);
        const vectors = await this.embedder.embed(
          batch.map(chunk => `search_document: ${chunk.heading}\n\n${chunk.content}`)
        );

        // Misma pauta que al indexar: transacción corta y siempre COMMIT (conexión compartida)
        await this.run('BEGIN');
        try {
          for (let i = 0; i < batch.length; i++) {
            await this.run('INSERT INTO docs_vectors (chunk_id, vector) VALUES (?, ?)', [
              batch[i].id,
              Buffer.from(new Float32Array(vectors[i]).buffer),
            ]);
          }
        } finally {
          await this.run('COMMIT');
        }

        onProgress({ phase: 'embed', percent: Math.round(((start + batch.length) / chunks.length) * 100) });
      }
    } catch (error) {
      await this.deleteTechVectors(key).catch(() => {});
      throw error;
    }

    await this.run('UPDATE docs_packs SET embed_model = ? WHERE tech = ?', [this.embedder.embedModel, key]);
  }

  async deleteTechVectors(tech) {
    this.vectorCache.delete(tech);
    await this.run('DELETE FROM docs_vectors WHERE chunk_id IN (SELECT id FROM docs_chunks WHERE tech = ?)', [tech]);
  }

  // Vectores de un paquete en una sola matriz en memoria (se cargan una vez por sesión):
  // JavaScript son ~8.000 fragmentos × 768 dimensiones ≈ 25 MB
  async loadVectors(tech) {
    if (!this.vectorCache.has(tech)) {
      const rows = await this.all(
        `SELECT v.chunk_id, v.vector FROM docs_vectors v
         JOIN docs_chunks c ON c.id = v.chunk_id WHERE c.tech = ?`,
        [tech]
      );
      const dim = rows.length > 0 ? rows[0].vector.byteLength / 4 : 0;
      const ids = new Array(rows.length);
      const matrix = new Float32Array(rows.length * dim);

      rows.forEach((row, i) => {
        ids[i] = row.chunk_id;
        // Copiar: el Buffer de SQLite puede no estar alineado a 4 bytes
        const bytes = row.vector.buffer.slice(row.vector.byteOffset, row.vector.byteOffset + row.vector.byteLength);
        matrix.set(new Float32Array(bytes), i * dim);
      });

      this.vectorCache.set(tech, { ids, matrix, dim });
    }
    return this.vectorCache.get(tech);
  }

  // IDs de los fragmentos más parecidos a la consulta, de más a menos (similitud coseno;
  // los vectores ya vienen normalizados, así que basta el producto escalar)
  async vectorSearch(tech, queryText, limit) {
    const { ids, matrix, dim } = await this.loadVectors(tech);
    if (ids.length === 0) {
      return [];
    }

    const [query] = await this.embedder.embed([`search_query: ${queryText}`]);
    const scores = new Float32Array(ids.length);
    for (let i = 0; i < ids.length; i++) {
      let dot = 0;
      const offset = i * dim;
      for (let d = 0; d < dim; d++) {
        dot += matrix[offset + d] * query[d];
      }
      scores[i] = dot;
    }

    return [...scores.keys()]
      .sort((a, b) => scores[b] - scores[a])
      .slice(0, limit)
      .map(i => ids[i]);
  }

  // Descarga JSON con reintentos. En vez de un límite de tiempo total (los paquetes grandes
  // tardan), aborta si el servidor deja de enviar datos: el CDN de DevDocs a veces se queda colgado
  async download(url, onDownloadProgress = () => {}) {
    for (let attempt = 1; ; attempt++) {
      const controller = new AbortController();
      let idleTimer;
      const resetIdleTimer = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => controller.abort(), DOWNLOAD_IDLE_TIMEOUT);
      };

      resetIdleTimer();
      try {
        const { data } = await axios.get(url, {
          signal: controller.signal,
          onDownloadProgress: event => {
            resetIdleTimer();
            onDownloadProgress(event);
          },
        });
        return data;
      } catch (error) {
        const reason = axios.isCancel(error) ? 'el servidor no responde' : error.code || error.message;
        if (attempt === DOWNLOAD_ATTEMPTS) {
          throw new Error(`No se pudo descargar la documentación (${reason})`);
        }
        console.warn(`Descarga fallida (${reason}), reintentando ${attempt + 1}/${DOWNLOAD_ATTEMPTS}: ${url}`);
      } finally {
        clearTimeout(idleTimer);
      }
    }
  }

  async remove(key) {
    if (this.installing === key) {
      throw new Error('No se puede eliminar mientras se está descargando');
    }

    await this.ready;
    await this.run('DELETE FROM docs_packs WHERE tech = ?', [key]);
    await this.deleteTechChunks(key);
    // Recuperar el espacio en disco (falla si hay otra instalación en curso: no es grave)
    await this.run('VACUUM').catch(error => console.error('VACUUM:', error.message));
  }

  async deleteTechChunks(tech) {
    await this.deleteTechVectors(tech);
    // Con FTS5 de contenido externo hay que borrar del índice con los valores originales
    await this.run(
      `INSERT INTO docs_fts (docs_fts, rowid, names, heading, content)
       SELECT 'delete', id, names, heading, content FROM docs_chunks WHERE tech = ?`,
      [tech]
    );
    await this.run('DELETE FROM docs_chunks WHERE tech = ?', [tech]);
  }

  async insertChunk(tech, path, chunk) {
    const { lastID } = await this.run(
      'INSERT INTO docs_chunks (tech, path, page_title, position, names, heading, content) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [tech, path, chunk.pageTitle, chunk.position, chunk.names, chunk.heading, chunk.content]
    );
    await this.run('INSERT INTO docs_fts (rowid, names, heading, content) VALUES (?, ?, ?, ?)', [
      lastID,
      chunk.names,
      chunk.heading,
      chunk.content,
    ]);
  }

  // --- Troceado de páginas ---

  // Agrupa las entradas del índice de DevDocs por página:
  // "path" → título de la página; "path#ancla" → nombres de API que están en esa ancla
  groupEntries(entries) {
    const byPage = new Map();

    for (const entry of entries) {
      const [page, anchor] = entry.path.split('#');
      if (!byPage.has(page)) {
        byPage.set(page, { title: null, names: [], anchors: new Map() });
      }
      const info = byPage.get(page);

      if (anchor) {
        const names = info.anchors.get(anchor) || [];
        names.push(entry.name);
        info.anchors.set(anchor, names);
      } else {
        // Las guías de DevDocs vienen numeradas ("2. Using middleware")
        info.title = info.title || entry.name.replace(/^\d+\.\s+/, '');
        info.names.push(entry.name);
      }
    }

    return byPage;
  }

  // Divide una página en secciones por encabezados (h1-h4) y cada sección en fragmentos
  chunkPage(html, info = { title: null, names: [], anchors: new Map() }) {
    const $ = cheerio.load(html, null, false);

    const sections = [];
    let current = { id: null, heading: '', html: '', ids: [] };

    // Recorre el documento en orden: cada h1-h4 abre una sección nueva. Los contenedores
    // (<main>, <section>, <div>...) que tienen encabezados dentro se recorren por dentro
    const visit = nodes => {
      nodes.each((_, node) => {
        const element = $(node);

        if (node.type === 'tag' && /^h[1-4]$/.test(node.tagName)) {
          sections.push(current);
          current = { id: element.attr('id') || null, heading: element.text().trim(), html: '', ids: [] };
          if (current.id) {
            current.ids.push(current.id);
          }
          if (node.tagName === 'h1' && !info.title) {
            info.title = current.heading;
          }
          return;
        }

        if (node.type === 'tag' && element.find('h1, h2, h3, h4').length > 0) {
          if (element.attr('id')) {
            current.ids.push(element.attr('id'));
          }
          visit(element.contents());
          return;
        }

        current.html += $.html(node);
        if (node.type === 'tag') {
          if (element.attr('id')) {
            current.ids.push(element.attr('id'));
          }
          element.find('[id]').each((__, child) => current.ids.push($(child).attr('id')));
        }
      });
    };

    visit($.root().contents());
    sections.push(current);

    const pageTitle = info.title || '';
    const chunks = [];

    sections.forEach((section, sectionIndex) => {
      if (SKIPPED_SECTION_IDS.has(section.id)) {
        return;
      }

      const markdown = section.html.trim() ? this.turndown.turndown(section.html).trim() : '';
      if (markdown.length < 20) {
        return;
      }

      const names = new Set(sectionIndex <= 1 ? info.names : []);
      for (const id of section.ids) {
        for (const name of info.anchors.get(id) || []) {
          names.add(name);
        }
      }

      const sectionHeading = section.heading && section.heading !== pageTitle ? section.heading : '';
      const heading = [pageTitle, sectionHeading].filter(Boolean).join(' › ');

      for (const piece of this.splitMarkdown(markdown)) {
        chunks.push({
          pageTitle,
          position: chunks.length,
          names: [...names].join('\n'), // Uno por línea para poder compararlos al ordenar
          heading,
          content: sectionHeading ? `## ${sectionHeading}\n\n${piece}` : piece,
        });
      }
    });

    return chunks;
  }

  // Parte el Markdown en trozos de ~CHUNK_CHARS sin cortar bloques de código
  splitMarkdown(markdown) {
    const blocks = [];
    let pending = [];
    let insideCode = false;

    for (const block of markdown.split(/\n{2,}/)) {
      pending.push(block);
      if ((block.match(/```/g) || []).length % 2 === 1) {
        insideCode = !insideCode;
      }
      // No partir mientras haya un bloque de código abierto
      if (!insideCode) {
        blocks.push(truncate(pending.join('\n\n'), MAX_BLOCK_CHARS));
        pending = [];
      }
    }
    if (pending.length > 0) {
      blocks.push(truncate(pending.join('\n\n'), MAX_BLOCK_CHARS));
    }

    const pieces = [];
    let current = '';
    for (const block of blocks) {
      if (current && current.length + block.length > CHUNK_CHARS) {
        pieces.push(current);
        current = '';
      }
      current = current ? `${current}\n\n${block}` : block;
    }
    if (current) {
      pieces.push(current);
    }

    return pieces;
  }

  // --- Búsqueda ---

  // Devuelve hasta maxResults páginas con sus fragmentos más relevantes,
  // o [] si la tecnología no está instalada o no hay coincidencias.
  // queryText: la consulta en texto libre, para la búsqueda semántica.
  // mode: 'hybrid' (por defecto), 'bm25' o 'vector' (para comparar en pruebas)
  async search(tech, tokens, { maxResults = 2, maxChars = 3500, queryText = '', mode = 'hybrid' } = {}) {
    await this.ready;

    const pack = await this.get('SELECT slug, embed_model FROM docs_packs WHERE tech = ?', [tech]);
    if (!pack) {
      return [];
    }

    const terms = [...new Set(tokens.flatMap(token => token.split(/[^\p{L}\p{N}]+/u)))].filter(t => t.length > 1);

    // 1) Texto completo: cualquier término puede coincidir; BM25 premia los fragmentos que
    // tienen más y más raros. Pesos por columna: names (nombres de API) > heading > content
    let bm25Rows = [];
    if (terms.length > 0 && mode !== 'vector') {
      const match = terms.map(term => `"${term.replace(/"/g, '""')}"`).join(' OR ');
      bm25Rows = await this.all(
        `SELECT c.id, c.path, c.page_title, c.position, c.names, c.heading, bm25(docs_fts, 10.0, 5.0, 1.0) AS rank
         FROM docs_fts JOIN docs_chunks c ON c.id = docs_fts.rowid
         WHERE docs_fts MATCH ? AND c.tech = ?
         ORDER BY rank
         LIMIT ${SEARCH_CANDIDATES}`,
        [match, tech]
      );
    }

    // 2) Semántica: encuentra fragmentos que hablan de lo mismo aunque no usen las mismas
    // palabras. Si Ollama no responde, se sigue solo con el texto completo
    let vectorRows = [];
    if (pack.embed_model && this.embedder && queryText && mode !== 'bm25') {
      try {
        const ids = await this.vectorSearch(tech, queryText, SEARCH_CANDIDATES);
        const rows = await this.all(
          `SELECT id, path, page_title, position, names, heading FROM docs_chunks WHERE id IN (${ids.map(() => '?').join(',')})`,
          ids
        );
        const byId = new Map(rows.map(row => [row.id, row]));
        vectorRows = ids.map(id => byId.get(id)).filter(Boolean);
      } catch (error) {
        console.error('Búsqueda semántica no disponible:', error.code || error.message);
      }
    }

    // 3) Fusión por posiciones (Reciprocal Rank Fusion): cada lista aporta peso / (k + posición).
    // No hace falta comparar puntuaciones de escalas distintas (BM25 frente a coseno).
    // Si la consulta es un nombre de API ("Array.isArray", "useState") manda el texto completo;
    // si es una descripción ("remove repeated items from a list"), manda la semántica
    const looksLikeApi = /[.()#]|[a-z][A-Z]/.test(queryText) || terms.length === 1;
    const weights = looksLikeApi ? [2, 1] : [1, 2];
    const fused = new Map();
    [bm25Rows, vectorRows].forEach((list, listIndex) => {
      list.forEach((row, index) => {
        const entry = fused.get(row.id) || { row, score: 0 };
        entry.score += weights[listIndex] / (RRF_K + index);
        fused.set(row.id, entry);
      });
    });

    // Primero las páginas dedicadas exactamente a lo buscado: "promise all" → Promise.all,
    // "array prototype map" → Array.prototype.map(). Sin esto, BM25 puede preferir una
    // página de error que menciona los mismos términos
    const normalize = text => (text || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const wanted = normalize(terms.join(''));
    const isExact = row =>
      wanted !== '' &&
      [...row.names.split('\n'), row.page_title, row.heading.split(' › ')[0]].some(name => normalize(name) === wanted);
    const ranked = [...fused.values()].map(entry => ({ ...entry, exact: isExact(entry.row) }));
    ranked.sort((a, b) => b.exact - a.exact || b.score - a.score);

    // Agrupar por página en orden de relevancia
    const pages = new Map();
    for (const { row } of ranked) {
      if (!pages.has(row.path)) {
        if (pages.size === maxResults) {
          continue;
        }
        pages.set(row.path, { title: row.page_title || row.path, matched: [] });
      }
      pages.get(row.path).matched.push(row.position);
    }

    const source = `${docsSources[tech].name} (offline)`;
    const results = [];

    for (const [path, page] of pages) {
      const chunks = await this.all(
        'SELECT position, heading, content FROM docs_chunks WHERE tech = ? AND path = ? ORDER BY position',
        [tech, path]
      );

      // Prioridad: introducción, secciones de referencia (sintaxis, parámetros...),
      // fragmentos que coinciden con la búsqueda y, si sobra sitio, el resto
      const priority = chunk => {
        if (chunk.position === 0) {
          return 0;
        }
        if (EXACT_REFERENCE_HEADINGS.test(chunk.heading.split(' › ')[1] || '')) {
          return 1;
        }
        const matchIndex = page.matched.indexOf(chunk.position);
        return matchIndex >= 0 ? 2 + matchIndex / SEARCH_CANDIDATES : 3;
      };

      const selected = [];
      let used = 0;
      for (const chunk of [...chunks].sort((a, b) => priority(a) - priority(b) || a.position - b.position)) {
        if (selected.length > 0 && used + chunk.content.length > maxChars) {
          continue;
        }
        selected.push(chunk);
        used += chunk.content.length;
      }
      selected.sort((a, b) => a.position - b.position);

      const headings = [...new Set(selected.map(chunk => chunk.heading.split(' › ')[1]).filter(Boolean))];
      results.push({
        title: page.title,
        url: `https://devdocs.io/${pack.slug}/${path}`,
        description: headings.join(', '),
        source,
        content: truncate(selected.map(chunk => chunk.content).join('\n\n'), maxChars),
      });
    }

    return results;
  }

  // --- SQLite con promesas ---

  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function (err) {
        if (err) {
          reject(err);
        } else {
          resolve({ lastID: this.lastID, changes: this.changes });
        }
      });
    });
  }

  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
  }

  all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
    });
  }
}

module.exports = DocsIndex;
