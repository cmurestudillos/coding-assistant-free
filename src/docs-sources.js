// Fuentes de documentación oficiales
const docsSources = {
  javascript: {
    name: 'JavaScript - MDN',
    baseUrl: 'https://developer.mozilla.org',
    searchUrl: 'https://developer.mozilla.org/en-US/search',
    docsPath: '/en-US/docs/Web/JavaScript',
    priority: 10,
    keywords: ['javascript', 'js', 'ecmascript', 'array', 'object', 'promise', 'async', 'function'],
  },

  typescript: {
    name: 'TypeScript',
    baseUrl: 'https://www.typescriptlang.org',
    searchUrl: 'https://www.typescriptlang.org/docs',
    docsPath: '/docs/handbook',
    priority: 9,
    keywords: ['typescript', 'ts', 'type', 'interface', 'generic', 'decorator'],
  },

  react: {
    name: 'React',
    baseUrl: 'https://react.dev',
    searchUrl: 'https://react.dev',
    docsPath: '/reference/react',
    priority: 9,
    keywords: ['react', 'jsx', 'hook', 'usestate', 'useeffect', 'component', 'props', 'state'],
  },

  vue: {
    name: 'Vue.js',
    baseUrl: 'https://vuejs.org',
    searchUrl: 'https://vuejs.org/api',
    docsPath: '/guide',
    priority: 9,
    keywords: ['vue', 'vuejs', 'composition', 'reactive', 'ref', 'computed', 'watch'],
  },

  angular: {
    name: 'Angular',
    baseUrl: 'https://angular.dev',
    searchUrl: 'https://angular.dev/api',
    docsPath: '/guide',
    priority: 9,
    keywords: ['angular', 'directive', 'component', 'service', 'module', 'dependency injection'],
  },

  nodejs: {
    name: 'Node.js',
    baseUrl: 'https://nodejs.org',
    searchUrl: 'https://nodejs.org/api',
    docsPath: '/api',
    priority: 9,
    keywords: ['node', 'nodejs', 'fs', 'http', 'stream', 'buffer', 'process'],
  },

  express: {
    name: 'Express.js',
    baseUrl: 'https://expressjs.com',
    searchUrl: 'https://expressjs.com/en/4x/api.html',
    docsPath: '/en/guide',
    priority: 8,
    keywords: ['express', 'middleware', 'router', 'req', 'res', 'next'],
  },

  mongodb: {
    name: 'MongoDB',
    baseUrl: 'https://www.mongodb.com',
    searchUrl: 'https://www.mongodb.com/docs/manual',
    docsPath: '/docs/manual',
    priority: 8,
    keywords: ['mongodb', 'mongoose', 'collection', 'document', 'query', 'aggregate'],
  },

  mdn_web: {
    name: 'Web APIs - MDN',
    baseUrl: 'https://developer.mozilla.org',
    searchUrl: 'https://developer.mozilla.org/en-US/search',
    docsPath: '/en-US/docs/Web/API',
    priority: 7,
    keywords: ['dom', 'fetch', 'api', 'web', 'browser', 'window', 'document'],
  },

  mdn_css: {
    name: 'CSS - MDN',
    baseUrl: 'https://developer.mozilla.org',
    searchUrl: 'https://developer.mozilla.org/en-US/search',
    docsPath: '/en-US/docs/Web/CSS',
    priority: 7,
    keywords: ['css', 'flexbox', 'grid', 'animation', 'selector', 'style'],
  },
};

module.exports = { docsSources };
