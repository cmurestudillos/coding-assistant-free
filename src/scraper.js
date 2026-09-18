const axios = require('axios');
const cheerio = require('cheerio');
const { docsSources } = require('./docs-sources');
const { createTurndown, truncate, REFERENCE_HEADINGS } = require('./markdown');

const MAX_RESULTS = 2;
const MAX_DOC_CHARS = 3500; // Contenido máximo por documento que se pasa al modelo
const REQUEST_TIMEOUT = 8000;

// Palabras que no ayudan a puntuar resultados (incluye nombres de tecnologías:
// ya se ha elegido la fuente, así que no sirven para distinguir páginas)
const STOPWORDS = new Set(
  `a an the in on of to for with and or is are how what why when use using example examples
  de la el los las un una en con para por que qué como cómo es se mi del al
  javascript js react vue vuejs angular node nodejs express expressjs typescript ts mongodb`.split(/\s+/)
);

// Módulos con documentación JSON propia en nodejs.org/api/<módulo>.json
const NODE_MODULES = `fs path http https http2 events stream buffer process os url crypto child_process util
  worker_threads zlib net timers readline cluster dns assert querystring perf_hooks async_hooks vm tls dgram
  module console test globals`.split(/\s+/);

// Nombres de API habituales que identifican el módulo de Node.js
const NODE_ALIASES = {
  eventemitter: 'events',
  readfile: 'fs',
  writefile: 'fs',
  readdir: 'fs',
  mkdir: 'fs',
  readable: 'stream',
  writable: 'stream',
  pipeline: 'stream',
  spawn: 'child_process',
  exec: 'child_process',
  fork: 'child_process',
  createserver: 'http',
  settimeout: 'timers',
  setinterval: 'timers',
  randomuuid: 'crypto',
  createhash: 'crypto',
  promisify: 'util',
};

// Secciones de MDN que no aportan al modelo
const MDN_SKIPPED_SECTIONS = new Set(['try_it', 'see_also']);

function tokenize(text) {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9_$áéíóúñ-]+/)
        .filter(token => token.length > 1 && !STOPWORDS.has(token))
    ),
  ];
}

// Número de tokens distintos que aparecen en el texto
function scoreText(text, tokens) {
  const lower = (text || '').toLowerCase();
  return tokens.filter(token => lower.includes(token)).length;
}

function keywordMatches(text, keyword) {
  const escaped = keyword.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9_])${escaped}($|[^a-z0-9_])`).test(text);
}

class DocsScraper {
  // docsIndex (opcional): índice local de paquetes DevDocs; si tiene la tecnología
  // instalada se consulta antes que la documentación online
  constructor(database, docsIndex = null) {
    this.db = database;
    this.docsIndex = docsIndex;
    this.userAgent = 'CodingAssistantFree/1.0 (documentation lookup)';
    this.turndown = createTurndown();
  }

  // Lista de fuentes para el selector de la interfaz
  getSources() {
    return Object.entries(docsSources).map(([key, source]) => ({ key, name: source.name }));
  }

  // Detectar tecnologías en la pregunta (por palabras completas)
  detectTechnologies(text) {
    const lower = text.toLowerCase();
    const detected = [];

    for (const [key, source] of Object.entries(docsSources)) {
      const matches = source.keywords.filter(keyword => keywordMatches(lower, keyword)).length;
      if (matches > 0) {
        detected.push({ key, matches, ...source });
      }
    }

    detected.sort((a, b) => b.priority - a.priority || b.matches - a.matches);

    if (detected.length === 0) {
      detected.push({ key: 'javascript', ...docsSources.javascript });
    }

    return detected;
  }

  // Detectar si la pregunta contiene código
  hasCode(query) {
    const codePatterns = [
      /```[\s\S]*```/, // Bloques de código markdown
      /`[^`]+`/, // Código inline
      /function\s+\w+/, // Funciones
      /const\s+\w+/, // Variables
      /let\s+\w+/,
      /var\s+\w+/,
      /class\s+\w+/, // Clases
      /import\s+/, // Imports
      /export\s+/, // Exports
      /=>/, // Arrow functions
      /console\.log/, // Console
      /<[^>]+>/, // JSX/HTML
    ];

    return codePatterns.some(pattern => pattern.test(query));
  }

  // Extraer código de la pregunta
  extractCode(query) {
    const codeBlockMatch = query.match(/```(\w+)?\n([\s\S]*?)```/);
    if (codeBlockMatch) {
      return {
        language: codeBlockMatch[1] || 'javascript',
        code: codeBlockMatch[2].trim(),
      };
    }

    const inlineCodeMatch = query.match(/`([^`]+)`/);
    if (inlineCodeMatch) {
      return {
        language: 'javascript',
        code: inlineCodeMatch[1].trim(),
      };
    }

    // Si no hay bloques explícitos pero parece código
    if (this.hasCode(query)) {
      return {
        language: 'javascript',
        code: query,
      };
    }

    return null;
  }

  // Buscar documentación relevante para una pregunta.
  // searchQuery: términos de búsqueda en inglés (generados por la IA)
  // technology: clave de docsSources elegida en la interfaz, 'none' para no buscar
  async searchDocs(question, { searchQuery = '', technology = '' } = {}) {
    if (technology === 'none') {
      return [];
    }

    const tech = docsSources[technology]
      ? { key: technology, ...docsSources[technology] }
      : this.detectTechnologies(`${question} ${searchQuery}`)[0];
    const query = searchQuery || question;
    const tokens = tokenize(query);

    console.log(`🔍 Buscando en ${tech.name}: "${query}"`);

    // 1) Índice local (sin conexión, instantáneo) si la tecnología está descargada
    if (this.docsIndex) {
      try {
        const local = await this.docsIndex.search(tech.key, tokens, {
          maxResults: MAX_RESULTS,
          maxChars: MAX_DOC_CHARS,
          queryText: query, // Para la búsqueda semántica, si el paquete tiene embeddings
        });
        if (local.length > 0) {
          return local;
        }
      } catch (error) {
        console.error('Error buscando en el índice local:', error.message);
      }
    }

    // 2) Documentación online
    try {
      const results = await this.searchProvider(tech, searchQuery, tokens);
      return results.slice(0, MAX_RESULTS);
    } catch (error) {
      console.error(`Error buscando en ${tech.name}:`, error.message);
      return this.staticLinks(tech);
    }
  }

  // Privacidad: solo la búsqueda de MDN envía texto a la web, y únicamente los términos
  // generados por el modelo, nunca el mensaje del usuario (que puede llevar su código).
  // El resto de proveedores descargan URLs fijas y ordenan los resultados en local
  searchProvider(tech, searchQuery, tokens) {
    switch (tech.provider) {
      case 'mdn':
        return searchQuery ? this.searchMDN(searchQuery, tech, tokens) : Promise.resolve(this.staticLinks(tech));
      case 'nodeApi':
        return this.searchNodeApi(tech, tokens);
      case 'llmsTxt':
        return this.searchLlmsTxt(tech, tokens);
      case 'express':
        return this.searchExpress(tech, tokens);
      default:
        return Promise.resolve(this.staticLinks(tech));
    }
  }

  // --- MDN: API de búsqueda + index.json de cada página ---

  async searchMDN(query, tech, tokens) {
    const searchUrl = `https://developer.mozilla.org/api/v1/search?q=${encodeURIComponent(query)}&locale=en-US&size=10`;
    const { documents = [] } = JSON.parse(await this.fetchCached(searchUrl));

    // Priorizar la sección de la tecnología detectada (JavaScript, Web APIs o CSS)
    const prefix = (tech.docsPath || '').toLowerCase();
    const inSection = doc => doc.mdn_url.toLowerCase().startsWith(prefix);
    const ranked = [...documents.filter(inSection), ...documents.filter(doc => !inSection(doc))];

    return Promise.all(
      ranked.slice(0, MAX_RESULTS).map(async doc => {
        const url = `https://developer.mozilla.org${doc.mdn_url}`;
        let content = '';

        try {
          const page = JSON.parse(await this.fetchCached(`${url}/index.json`));
          content = this.pickRelevant(this.mdnPageToMarkdown(page.doc), tokens);
        } catch (error) {
          console.error(`Error leyendo ${url}:`, error.message);
        }

        return { title: doc.title, url, description: doc.summary || '', source: 'MDN', content };
      })
    );
  }

  mdnPageToMarkdown(doc) {
    const parts = [];

    for (const section of doc.body || []) {
      const value = section.value || {};
      if (section.type !== 'prose' || MDN_SKIPPED_SECTIONS.has(value.id)) {
        continue;
      }

      const heading = value.title ? `## ${value.title}\n\n` : '';
      parts.push(heading + (value.content ? this.htmlToMarkdown(value.content) : ''));
    }

    return parts.join('\n\n');
  }

  // --- Node.js: JSON oficial de cada módulo ---

  async searchNodeApi(tech, tokens) {
    const moduleName = this.detectNodeModule(tokens);
    if (!moduleName) {
      return this.staticLinks(tech);
    }

    const api = JSON.parse(await this.fetchCached(`https://nodejs.org/api/${moduleName}.json`));
    const items = [];
    this.collectNodeItems(api, items);

    const itemTokens = tokens.filter(token => token !== moduleName);
    const ranked = items
      .map((item, index) => ({
        item,
        index,
        score:
          scoreText(item.textRaw, itemTokens) * 2 +
          (itemTokens.includes((item.name || '').toLowerCase()) ? 3 : 0) +
          // Preferir la API del propio módulo (fs.readFile) frente a otras clases (filehandle.readFile)
          (item.textRaw.replace(/`/g, '').startsWith(`${moduleName}.`) ? 1 : 0) +
          scoreText(item.desc, itemTokens) * 0.5,
      }))
      .filter(entry => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, 3)
      .map(entry => entry.item);

    // Sin coincidencias concretas: usar la introducción del módulo
    const selected = ranked.length > 0 ? ranked : items.slice(0, 1);
    const content = selected.map(item => this.nodeItemToMarkdown(item)).join('\n\n');
    const title = selected[0] ? selected[0].textRaw.replace(/`/g, '') : moduleName;

    return [
      {
        title: `Node.js: ${title}`,
        url: `https://nodejs.org/api/${moduleName}.html`,
        description: `Documentación del módulo ${moduleName} de Node.js`,
        source: 'Node.js',
        content: truncate(content, MAX_DOC_CHARS),
      },
    ];
  }

  detectNodeModule(tokens) {
    for (const token of tokens) {
      if (NODE_MODULES.includes(token)) {
        return token;
      }
    }
    for (const token of tokens) {
      if (NODE_ALIASES[token]) {
        return NODE_ALIASES[token];
      }
    }
    return null;
  }

  // Recorre el árbol del JSON de Node.js y aplana métodos, clases, propiedades...
  collectNodeItems(node, items) {
    const childKeys = 'modules classes ctors methods classMethods properties events miscs globals'.split(' ');

    for (const key of childKeys) {
      for (const child of node[key] || []) {
        if (child.textRaw) {
          items.push(child);
        }
        this.collectNodeItems(child, items);
      }
    }
  }

  nodeItemToMarkdown(item) {
    let markdown = `### ${item.textRaw}\n\n`;

    const signature = (item.signatures || [])[0];
    if (signature) {
      const describeParam = (param, indent = '') => {
        let line = `${indent}- \`${param.name}\`${param.type ? ` {${param.type}}` : ''}`;
        if (param.desc) {
          line += ` ${this.htmlToMarkdown(param.desc)}`;
        }
        const nested = (param.options || []).map(option => describeParam(option, indent + '  '));
        return [line, ...nested].join('\n');
      };

      const params = (signature.params || []).map(param => describeParam(param));
      if (params.length > 0) {
        markdown += `${params.join('\n')}\n`;
      }
      if (signature.return) {
        markdown += `- Devuelve: {${signature.return.type || ''}} ${this.htmlToMarkdown(signature.return.desc || '')}\n`;
      }
      markdown += '\n';
    }

    if (item.desc) {
      markdown += this.htmlToMarkdown(item.desc);
    }

    return markdown.trim();
  }

  // --- React, Vue, Angular: índice llms.txt + página de la documentación ---

  async searchLlmsTxt(tech, tokens) {
    const entries = this.parseLlmsTxt(await this.fetchCached(tech.llmsTxtUrl), tech.baseUrl);

    const ranked = entries
      .map((entry, index) => ({
        entry,
        index,
        score:
          scoreText(entry.title, tokens) * 3 +
          scoreText(new URL(entry.url).pathname, tokens) * 2 +
          scoreText(entry.description, tokens) +
          // Página dedicada exactamente a lo buscado (p. ej. /reference/react/useState)
          (tokens.includes(this.lastPathSegment(entry.url)) ? 5 : 0),
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, MAX_RESULTS)
      .map(({ entry }) => entry);

    if (ranked.length === 0) {
      return this.staticLinks(tech);
    }

    return Promise.all(
      ranked.map(async entry => {
        let content = '';

        try {
          content = this.pickRelevant(await this.fetchPageMarkdown(entry.url), tokens);
        } catch (error) {
          console.error(`Error leyendo ${entry.url}:`, error.message);
        }

        return {
          title: entry.title,
          // Las versiones .md son para máquinas: enlazar a la página normal
          url: entry.url.replace(/\.md$/, ''),
          description: entry.description,
          source: tech.name,
          content,
        };
      })
    );
  }

  lastPathSegment(url) {
    const segments = new URL(url).pathname.replace(/\.md$/, '').split('/');
    return (segments.pop() || '').toLowerCase();
  }

  // Formato: "- [Título](url): descripción opcional"
  parseLlmsTxt(text, baseUrl) {
    const entries = [];
    const linkPattern = /^\s*[-*]\s+\[([^\]]+)\]\(([^)\s]+)\)(?::\s*(.*))?/;

    for (const line of text.split('\n')) {
      const match = line.match(linkPattern);
      if (!match || match[2].endsWith('.txt')) {
        continue;
      }

      entries.push({
        title: match[1].replace(/\s*\{#[^}]*\}/, '').trim(),
        url: new URL(match[2], baseUrl).href,
        description: (match[3] || '').trim(),
      });
    }

    return entries;
  }

  async fetchPageMarkdown(url) {
    const text = await this.fetchCached(url);

    if (url.endsWith('.md') || !text.trimStart().startsWith('<')) {
      return (
        text
          // Anclas MDX de react.dev en los encabezados: "## Usage {/*usage*/}"
          .replace(/\s*\{\/\*.*?\*\/\}/g, '')
          // Índice del sitio que react.dev añade al final de cada página
          .replace(/\n#{1,2} Sitemap\n[\s\S]*$/, '')
      );
    }

    const $ = cheerio.load(text);
    $('script, style, nav, aside, header, footer, [class*="table-of-contents"]').remove();
    const main = $('main').first().length
      ? $('main').first()
      : $('article').first().length
        ? $('article').first()
        : $('body');

    return this.htmlToMarkdown(main.html() || '');
  }

  // --- Express: documentación completa en texto para LLMs ---

  async searchExpress(tech, tokens) {
    const texts = await Promise.all(tech.textUrls.map(url => this.fetchCached(url)));
    const sections = texts.flatMap(text => this.splitExpressSections(text));

    const ranked = sections
      .map((section, index) => ({
        section,
        index,
        score: scoreText(section.title, tokens) * 3 + scoreText(section.body, tokens),
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index);

    if (ranked.length === 0) {
      return this.staticLinks(tech);
    }

    // Agrupar las mejores secciones por página, en orden de relevancia
    const pages = new Map();
    for (const { section } of ranked.slice(0, 8)) {
      if (!pages.has(section.url)) {
        if (pages.size === MAX_RESULTS) {
          continue;
        }
        pages.set(section.url, { title: section.pageTitle, sections: [] });
      }
      pages.get(section.url).sections.push(section);
    }

    return [...pages.entries()].map(([url, page]) => {
      let content = '';
      for (const section of page.sections) {
        const block = `## ${section.title}\n\n${section.body.trim()}\n\n`;
        if (content && content.length + block.length > MAX_DOC_CHARS) {
          break;
        }
        content += block;
      }

      return {
        title: `Express: ${page.title}`,
        url,
        description: page.sections.map(section => section.title).join(', '),
        source: tech.name,
        content: truncate(content.trim(), MAX_DOC_CHARS),
      };
    });
  }

  // Cada página del fichero empieza con "## Título" seguido de "URL: ..."
  splitExpressSections(text) {
    const sections = [];
    let pageUrl = 'https://expressjs.com';
    let pageTitle = 'Express';
    let current = null;

    for (const line of text.split('\n')) {
      const heading = line.match(/^#{2,4}\s+(.*)/);
      const urlLine = line.match(/^URL:\s*(https?:\/\/\S+)/);

      if (urlLine && current) {
        pageUrl = urlLine[1];
        pageTitle = current.title;
        current.url = pageUrl;
        current.pageTitle = pageTitle;
      } else if (heading) {
        current = { title: heading[1].trim(), body: '', url: pageUrl, pageTitle };
        sections.push(current);
      } else if (current) {
        current.body += line + '\n';
      }
    }

    return sections;
  }

  // --- Utilidades ---

  staticLinks(tech) {
    const links = tech.links || [{ title: tech.name, url: tech.baseUrl, description: '' }];
    return links.map(link => ({ ...link, source: tech.name, content: '' }));
  }

  // Descarga una URL como texto, usando la caché de páginas de la base de datos
  async fetchCached(url) {
    const cached = await this.db.getCachedPage(url);
    if (cached !== null) {
      return cached;
    }

    const response = await axios.get(url, {
      headers: { 'User-Agent': this.userAgent },
      timeout: REQUEST_TIMEOUT,
      responseType: 'text',
      transformResponse: data => data,
    });

    await this.db.saveCachedPage(url, response.data).catch(error => {
      console.error('Error guardando caché de documentación:', error.message);
    });

    return response.data;
  }

  htmlToMarkdown(html) {
    return this.turndown.turndown(html).trim();
  }

  // Recorta un documento largo quedándose con la introducción y las secciones
  // que más coinciden con la búsqueda, manteniendo el orden original
  pickRelevant(markdown, tokens, maxChars = MAX_DOC_CHARS) {
    if (markdown.length <= maxChars) {
      return markdown;
    }

    const [intro, ...sections] = markdown.split(/\n(?=#{1,4} )/);
    const ranked = sections
      .map((text, index) => {
        const heading = text.split('\n', 1)[0];
        const score =
          scoreText(heading, tokens) * 3 +
          scoreText(text, tokens) +
          // Las secciones de referencia entran siempre antes que los ejemplos
          (REFERENCE_HEADINGS.test(heading) ? 100 : 0) +
          (text.includes('```') ? 1 : 0);
        return { text, index, score };
      })
      .sort((a, b) => b.score - a.score || a.index - b.index);

    const introText = truncate(intro.trim(), Math.floor(maxChars / 3));
    let used = introText.length;
    const selected = [];

    for (const section of ranked) {
      if (used + section.text.length > maxChars) {
        continue;
      }
      selected.push(section);
      used += section.text.length;
    }

    // Si ninguna sección cabe entera, recortar la más relevante
    if (selected.length === 0 && ranked.length > 0) {
      selected.push({ ...ranked[0], text: truncate(ranked[0].text, maxChars - used) });
    }

    selected.sort((a, b) => a.index - b.index);
    return [introText, ...selected.map(section => section.text.trim())].join('\n\n');
  }

  // Bloque de documentación para el prompt, numerado para poder citarlo como [n]
  formatDocsForAI(results) {
    return results
      .map((result, index) => {
        const body = result.content || result.description || '(solo enlace, sin contenido)';
        return `[${index + 1}] ${result.title} (${result.source})\nURL: ${result.url}\n\n${body}`;
      })
      .join('\n\n---\n\n');
  }

  // Datos de las fuentes que se guardan con el mensaje y se muestran en la interfaz
  toSources(results) {
    return results.map(({ title, url, source }) => ({ title, url, source }));
  }
}

module.exports = DocsScraper;
