const TurndownService = require('turndown');

// Conversor HTML → Markdown compartido por la búsqueda online y el índice local
function createTurndown() {
  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });

  turndown.remove(['script', 'style', 'img', 'svg', 'button']);
  // Cabecera "js"/"css" de los ejemplos de MDN, indicador "Baseline" de compatibilidad
  // e historial de cambios por versión de Node.js
  turndown.remove(node => /\b(example-header|baseline-indicator|changelog)\b/.test(node.getAttribute('class') || ''));
  // Los enlaces no le sirven al modelo y ocupan contexto: dejar solo el texto
  turndown.addRule('linkText', { filter: 'a', replacement: content => content });
  // MDN, DevDocs y otros sitios usan <pre> sin <code>: conservarlos como bloques de código
  turndown.addRule('preformatted', {
    filter: 'pre',
    replacement: (_content, node) => {
      const className = node.getAttribute('class') || '';
      const language =
        node.getAttribute('data-language') ||
        (className.match(/brush:\s*([\w-]+)/) || className.match(/language-([\w-]+)/) || [])[1];
      const code = node.textContent.replace(/\n$/, '');
      return `\n\n\`\`\`${language || ''}\n${code}\n\`\`\`\n\n`;
    },
  });

  return turndown;
}

function truncate(text, maxChars) {
  return text.length <= maxChars ? text : text.substring(0, maxChars).trimEnd() + '\n[…]';
}

// Secciones de referencia (sintaxis, parámetros...): lo primero que debe ver el modelo
const REFERENCE_HEADINGS = /syntax|parameters|return value|description|usage|reference|api/i;

// Versión estricta para el índice local: solo el título exacto de la sección. Con la
// laxa, en páginas grandes (p. ej. el módulo fs de Node) "Promises API" desplazaría a
// la sección de fs.readFile
const EXACT_REFERENCE_HEADINGS = /^(syntax|parameters|return value|description|exceptions)$/i;

module.exports = { createTurndown, truncate, REFERENCE_HEADINGS, EXACT_REFERENCE_HEADINGS };
