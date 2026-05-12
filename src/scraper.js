const axios = require('axios');
const cheerio = require('cheerio');
const { docsSources } = require('./docs-sources');

class DocsScraper {
  constructor(database) {
    this.db = database;
    this.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
  }

  // Detectar tecnologías en la pregunta
  detectTechnologies(query) {
    const queryLower = query.toLowerCase();
    const detected = [];

    for (const [key, source] of Object.entries(docsSources)) {
      const matches = source.keywords.some(keyword => queryLower.includes(keyword.toLowerCase()));

      if (matches) {
        detected.push({ key, ...source });
      }
    }

    detected.sort((a, b) => b.priority - a.priority);

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

  // Buscar en documentación (versión simplificada)
  async searchDocs(query, maxResults = 2) {
    try {
      const cached = await this.db.getCachedDocs(query);
      if (cached) {
        console.log('📦 Usando caché para:', query);
        return cached;
      }

      console.log('🔍 Buscando documentación...');
      const technologies = this.detectTechnologies(query);
      const results = [];

      // Buscar solo en la tecnología más relevante
      const tech = technologies[0];

      try {
        // Buscar en MDN si es JavaScript/Web
        if (tech.key.includes('javascript') || tech.key.includes('mdn')) {
          const mdnResults = await this.quickSearchMDN(query);
          results.push(...mdnResults.slice(0, maxResults));
        }
        // Para otras tecnologías, buscar documentación específica
        else {
          const specificResults = await this.quickSearchTech(query, tech);
          results.push(...specificResults.slice(0, maxResults));
        }
      } catch (error) {
        console.error(`Error buscando docs:`, error.message);
      }

      if (results.length > 0) {
        await this.db.saveCachedDocs(query, results, tech.name);
      }

      return results;
    } catch (error) {
      console.error('Error en searchDocs:', error);
      return [];
    }
  }

  // Búsqueda rápida en MDN
  async quickSearchMDN(query) {
    try {
      const keywords = query.toLowerCase().split(' ').slice(0, 3).join(' ');
      const searchUrl = `https://developer.mozilla.org/en-US/search?q=${encodeURIComponent(keywords)}`;

      const response = await axios.get(searchUrl, {
        headers: { 'User-Agent': this.userAgent },
        timeout: 5000,
      });

      const $ = cheerio.load(response.data);
      const results = [];

      $('.result-item')
        .slice(0, 2)
        .each((i, elem) => {
          const title = $(elem).find('.result-title').text().trim();
          const url = 'https://developer.mozilla.org' + $(elem).find('a').attr('href');
          const description = $(elem).find('.result-description').text().trim();

          if (title && url) {
            results.push({
              title,
              url,
              description: description.substring(0, 200),
              source: 'MDN',
            });
          }
        });

      return results;
    } catch (_error) {
      return [];
    }
  }

  // Búsqueda rápida tecnología específica
  async quickSearchTech(query, tech) {
    // Para React, Vue, etc., retornar links útiles
    const commonDocs = {
      react: [
        {
          title: 'React Docs',
          url: 'https://react.dev',
          description: 'Documentación oficial de React',
          source: 'React',
        },
      ],
      vue: [
        {
          title: 'Vue Docs',
          url: 'https://vuejs.org/guide',
          description: 'Documentación oficial de Vue',
          source: 'Vue',
        },
      ],
      angular: [
        {
          title: 'Angular Docs',
          url: 'https://angular.dev/overview',
          description: 'Documentación oficial de Angular',
          source: 'Angular',
        },
      ],
      nodejs: [
        { title: 'Node.js API', url: 'https://nodejs.org/api/', description: 'API de Node.js', source: 'Node.js' },
      ],
      express: [
        {
          title: 'Express Guide',
          url: 'https://expressjs.com/en/guide/routing.html',
          description: 'Guía de Express',
          source: 'Express',
        },
      ],
      mongodb: [
        {
          title: 'MongoDB Manual',
          url: 'https://www.mongodb.com/docs/manual/',
          description: 'Manual de MongoDB',
          source: 'MongoDB',
        },
      ],
    };

    return commonDocs[tech.key] || [];
  }

  // Formatear respuesta con docs
  formatDocsForAI(results) {
    if (results.length === 0) {
      return '';
    }

    let context = '\n\n📚 Documentación relevante encontrada:\n\n';

    results.forEach((result, index) => {
      context += `${index + 1}. ${result.title} (${result.source})\n`;
      context += `   ${result.description}\n`;
      context += `   URL: ${result.url}\n\n`;
    });

    return context;
  }
}

module.exports = DocsScraper;
