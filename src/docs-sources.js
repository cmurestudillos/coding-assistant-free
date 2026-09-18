// Fuentes de documentación oficiales
//
// provider indica cómo se obtiene el contenido (ver src/scraper.js):
// - mdn:     API de búsqueda JSON de MDN + index.json de cada página
// - nodeApi: JSON oficial de la API de Node.js por módulo
// - llmsTxt: índice llms.txt del sitio + páginas en Markdown/HTML
// - express: ficheros de texto completos publicados para LLMs
// - static:  sin contenido, solo enlaces a la documentación
//
// devdocs es el nombre del paquete en devdocs.io/docs.json que se puede descargar
// para consultarlo sin conexión (ver src/docs-index.js). MongoDB usa el de Mongoose,
// que es el que existe en DevDocs.
//
// Las keywords se comparan como palabras completas, así que conviene evitar
// términos genéricos que aparezcan en preguntas de cualquier tecnología.
// Los frameworks tienen más prioridad que JavaScript/MDN para que una pregunta
// como "arrays en React" consulte la documentación de React.
const docsSources = {
  javascript: {
    name: 'JavaScript - MDN',
    provider: 'mdn',
    devdocs: 'JavaScript',
    baseUrl: 'https://developer.mozilla.org',
    docsPath: '/en-US/docs/Web/JavaScript',
    priority: 7,
    keywords: ['javascript', 'js', 'ecmascript', 'array', 'object', 'promise', 'async', 'await', 'function'],
  },

  typescript: {
    name: 'TypeScript',
    provider: 'static',
    devdocs: 'TypeScript',
    baseUrl: 'https://www.typescriptlang.org',
    docsPath: '/docs/handbook',
    priority: 9,
    keywords: ['typescript', 'ts', 'interface', 'generic', 'generics', 'decorator', 'tsconfig'],
    links: [
      {
        title: 'TypeScript Handbook',
        url: 'https://www.typescriptlang.org/docs/handbook/intro.html',
        description: 'Documentación oficial de TypeScript',
      },
    ],
  },

  react: {
    name: 'React',
    provider: 'llmsTxt',
    devdocs: 'React',
    baseUrl: 'https://react.dev',
    llmsTxtUrl: 'https://react.dev/llms.txt',
    priority: 10,
    keywords: ['react', 'jsx', 'hook', 'hooks', 'usestate', 'useeffect', 'usememo', 'usecallback', 'useref', 'props'],
    links: [{ title: 'React Docs', url: 'https://react.dev', description: 'Documentación oficial de React' }],
  },

  vue: {
    name: 'Vue.js',
    provider: 'llmsTxt',
    devdocs: 'Vue',
    baseUrl: 'https://vuejs.org',
    llmsTxtUrl: 'https://vuejs.org/llms.txt',
    priority: 10,
    keywords: ['vue', 'vuejs', 'composition', 'reactive', 'computed', 'pinia', 'v-model', 'v-if', 'v-for'],
    links: [{ title: 'Vue Docs', url: 'https://vuejs.org/guide', description: 'Documentación oficial de Vue' }],
  },

  angular: {
    name: 'Angular',
    provider: 'llmsTxt',
    devdocs: 'Angular',
    baseUrl: 'https://angular.dev',
    llmsTxtUrl: 'https://angular.dev/llms.txt',
    priority: 10,
    keywords: ['angular', 'directive', 'ngmodule', 'ngif', 'ngfor', 'signal', 'signals', 'rxjs', 'observable'],
    links: [
      { title: 'Angular Docs', url: 'https://angular.dev/overview', description: 'Documentación oficial de Angular' },
    ],
  },

  nodejs: {
    name: 'Node.js',
    provider: 'nodeApi',
    devdocs: 'Node.js',
    baseUrl: 'https://nodejs.org',
    docsPath: '/api',
    priority: 9,
    keywords: ['node', 'nodejs', 'fs', 'http', 'stream', 'buffer', 'process', 'eventemitter', 'child_process'],
    links: [{ title: 'Node.js API', url: 'https://nodejs.org/api/', description: 'API de Node.js' }],
  },

  express: {
    name: 'Express.js',
    provider: 'express',
    devdocs: 'Express',
    baseUrl: 'https://expressjs.com',
    textUrls: ['https://expressjs.com/llms/api-5x.txt', 'https://expressjs.com/llms/guides-5x.txt'],
    priority: 10,
    keywords: ['express', 'expressjs', 'middleware', 'router', 'req', 'res'],
    links: [
      {
        title: 'Express Guide',
        url: 'https://expressjs.com/en/5x/guide/routing',
        description: 'Guía de Express',
      },
    ],
  },

  mongodb: {
    name: 'MongoDB',
    provider: 'static',
    devdocs: 'Mongoose',
    devdocsTitle: 'MongoDB (Mongoose)',
    baseUrl: 'https://www.mongodb.com',
    docsPath: '/docs/manual',
    priority: 9,
    keywords: ['mongodb', 'mongo', 'mongoose', 'collection', 'aggregate', 'aggregation'],
    links: [
      {
        title: 'MongoDB Manual',
        url: 'https://www.mongodb.com/docs/manual/',
        description: 'Manual de MongoDB',
      },
    ],
  },

  mdn_web: {
    name: 'Web APIs - MDN',
    provider: 'mdn',
    devdocs: 'Web APIs',
    baseUrl: 'https://developer.mozilla.org',
    docsPath: '/en-US/docs/Web/API',
    priority: 6,
    keywords: ['dom', 'fetch', 'browser', 'window', 'document', 'localstorage', 'addeventlistener', 'queryselector'],
  },

  mdn_css: {
    name: 'CSS - MDN',
    provider: 'mdn',
    devdocs: 'CSS',
    baseUrl: 'https://developer.mozilla.org',
    docsPath: '/en-US/docs/Web/CSS',
    priority: 6,
    keywords: ['css', 'flexbox', 'flex', 'grid', 'animation', 'selector', 'style', 'media query'],
  },
};

module.exports = { docsSources };
