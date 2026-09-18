const axios = require('axios');

// Ejemplos para extractSearchQuery: pregunta → términos de búsqueda en inglés
const SEARCH_QUERY_EXAMPLES = [
  ['¿Cómo leo un fichero en node?', 'fs.readFile'],
  ['¿Cómo recorro un array y devuelvo otro con los valores cambiados?', 'Array.prototype.map'],
  ['centrar un div vertical y horizontalmente', 'flexbox align-items justify-content'],
  ['¿Cómo guardo el estado de un contador en un componente de React?', 'useState'],
];

class AIEngine {
  constructor() {
    this.ollamaUrl = 'http://localhost:11434';
    this.model = 'qwen2.5-coder:3b';
    this.availableModels = [
      { name: 'qwen2.5-coder:3b', description: '⭐ Qwen Coder 3B - Rápido', size: '2GB' },
      { name: 'deepseek-coder:1.3b', description: 'DeepSeek 1.3B - Ultra rápido', size: '1GB' },
      { name: 'llama3.2:3b', description: 'Llama 3.2 3B - Equilibrado', size: '2GB' },
    ];
    this.isOllamaRunning = false;
    // Ollama usa por defecto un contexto pequeño y recorta sin avisar lo que no cabe.
    // Todas las llamadas deben usar el mismo valor: si cambia, Ollama recarga el modelo (~5 s)
    this.contextWindow = 8192;
    // Cuánto tiempo mantiene Ollama el modelo en memoria sin uso (por defecto 5 min;
    // pasado ese tiempo, la siguiente pregunta espera a que se vuelva a cargar)
    this.keepAlive = '30m';
    // Modelo de embeddings para la búsqueda semántica en la documentación offline (opcional)
    this.embedModel = 'nomic-embed-text';
  }

  // Carga los modelos en memoria en segundo plano para que la primera pregunta no espere
  // a la carga en frío. No hace nada si Ollama no está corriendo
  async warmUp() {
    try {
      await axios.post(
        `${this.ollamaUrl}/api/generate`,
        { model: this.model, prompt: '', keep_alive: this.keepAlive, options: { num_ctx: this.contextWindow } },
        { timeout: 120000 }
      );
      if (await this.hasEmbedModel()) {
        await this.embed(['search_query: warm up']);
      }
    } catch (error) {
      console.warn('No se pudo precargar el modelo:', error.code || error.message);
    }
  }

  // ¿Está instalado el modelo de embeddings? (los nombres llegan como "nomic-embed-text:latest")
  async hasEmbedModel() {
    const status = await this.checkOllama();
    return status.models.some(model => model.name.split(':')[0] === this.embedModel);
  }

  // Vectores (normalizados) de varios textos. nomic-embed-text espera el prefijo
  // "search_document: " en los textos indexados y "search_query: " en las búsquedas
  async embed(texts) {
    const { data } = await axios.post(
      `${this.ollamaUrl}/api/embed`,
      { model: this.embedModel, input: texts, keep_alive: this.keepAlive, truncate: true },
      { timeout: 120000 }
    );
    return data.embeddings;
  }

  async checkOllama() {
    try {
      const response = await axios.get(`${this.ollamaUrl}/api/tags`, { timeout: 3000 });
      this.isOllamaRunning = true;
      return { running: true, models: response.data.models || [] };
    } catch (_error) {
      this.isOllamaRunning = false;
      return { running: false, models: [] };
    }
  }

  // history: mensajes anteriores [{ role: 'user' | 'assistant', content }]
  // docs: documentación ya formateada y numerada para citar como [n]
  async generate(prompt, history = [], docs = '') {
    try {
      let systemPrompt = `Eres un asistente experto en programación. Responde de forma directa y concisa.

REGLAS:
- Responde en el mismo idioma que el usuario
- Genera código limpio y funcional
- Usa bloques de código con el lenguaje indicado (por ejemplo \`\`\`javascript)
- Sé breve, máximo 500 palabras
- Ve directo al punto`;

      let userContent = prompt;

      if (docs) {
        systemPrompt += `
- Se te da documentación oficial numerada. Úsala como fuente principal y cítala con [1], [2]...
- Si la documentación no cubre la pregunta, dilo y responde con tu propio conocimiento`;
        // La documentación va en el último mensaje para que Ollama no la descarte al recortar el
        // contexto. El recordatorio de citar va al final: es donde un modelo pequeño más caso hace
        userContent = `Documentación oficial relevante:\n\n${docs}\n\n===\n\nPregunta: ${prompt}\n\n(Apóyate en la documentación de arriba y cita la fuente con [1] o [2] junto a lo que saques de ella.)`;
      }

      const response = await axios.post(
        `${this.ollamaUrl}/api/chat`,
        {
          model: this.model,
          messages: [{ role: 'system', content: systemPrompt }, ...history, { role: 'user', content: userContent }],
          stream: false,
          keep_alive: this.keepAlive,
          options: {
            temperature: 0.3,
            top_p: 0.9,
            top_k: 40,
            num_predict: 800,
            num_ctx: this.contextWindow,
          },
        },
        {
          timeout: 180000, // 3 minutos
        }
      );

      return {
        success: true,
        response: response.data.message.content,
        model: this.model,
      };
    } catch (error) {
      let errorMessage = error.message;

      if (error.code === 'ECONNREFUSED') {
        errorMessage = 'No se puede conectar con Ollama. Asegúrate de que está corriendo (ollama serve)';
      } else if (error.code === 'ETIMEDOUT' || errorMessage.includes('timeout')) {
        errorMessage = `Timeout de ${this.model}. El modelo tardó demasiado en responder. Intenta: 1) Pregunta más corta 2) Modelo más ligero 3) Cerrar otras apps`;
      }

      console.error('Error generando con IA:', errorMessage);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  // Convierte la pregunta (normalmente en español) en términos de búsqueda en inglés,
  // que es el idioma de la documentación oficial. Devuelve '' si no lo consigue.
  async extractSearchQuery(question) {
    try {
      const response = await axios.post(
        `${this.ollamaUrl}/api/chat`,
        {
          model: this.model,
          messages: [
            {
              role: 'system',
              content: `You turn programming questions into a short English search query (1-4 words) for official documentation.
Prefer the exact API name that answers the question. Reply only with JSON: {"query": "..."}`,
            },
            // Ejemplos: un modelo pequeño los imita mejor que una instrucción
            ...SEARCH_QUERY_EXAMPLES.flatMap(([question, query]) => [
              { role: 'user', content: question },
              { role: 'assistant', content: JSON.stringify({ query }) },
            ]),
            { role: 'user', content: question.substring(0, 1000) },
          ],
          stream: false,
          format: 'json',
          keep_alive: this.keepAlive,
          // Mismo num_ctx que generate(): si no, Ollama recarga el modelo en cada llamada
          options: { temperature: 0, num_predict: 40, num_ctx: this.contextWindow },
        },
        { timeout: 60000 }
      );

      const { query } = JSON.parse(response.data.message.content);
      return typeof query === 'string' ? query.trim() : '';
    } catch (error) {
      console.error('Error generando términos de búsqueda:', error.code || error.message);
      return '';
    }
  }

  async analyzeCode(code, language, question = '', docs = '') {
    const prompt = `Analiza este código ${language}:

\`\`\`${language}
${code}
\`\`\`

${question ? `Pregunta: ${question}` : 'Analiza el código'}

Responde brevemente con:
1. Qué hace
2. Errores (si hay)
3. Código mejorado`;

    return await this.generate(prompt, [], docs);
  }

  async generateCode(description, language = 'javascript') {
    const prompt = `Genera código ${language} para: ${description}

Requisitos:
- Código limpio y funcional
- Comentarios breves
- Ejemplo de uso

Solo el código, nada más.`;

    return await this.generate(prompt);
  }

  async fixError(code, errorMessage, language) {
    const prompt = `Error en ${language}:

\`\`\`${language}
${code}
\`\`\`

Error: ${errorMessage}

Proporciona:
1. Causa del error
2. Código corregido`;

    return await this.generate(prompt);
  }

  getSystemPrompt() {
    return `Asistente de programación experto. Respuestas directas y concisas.`;
  }

  async setModel(modelName) {
    const status = await this.checkOllama();
    if (!status.running) {
      throw new Error('Ollama no está corriendo');
    }

    const modelExists = status.models.some(m => m.name === modelName);

    if (!modelExists) {
      await this.pullModel(modelName);
    }

    this.model = modelName;
    this.warmUp();
    return { success: true, model: modelName };
  }

  async pullModel(modelName) {
    try {
      await axios.post(`${this.ollamaUrl}/api/pull`, { name: modelName, stream: false }, { timeout: 600000 });
      return { success: true };
    } catch (error) {
      throw new Error(`Error descargando modelo: ${error.message}`);
    }
  }

  getAvailableModels() {
    return this.availableModels;
  }

  async optimizeCode(code, language, focus = 'general') {
    const focusGuides = {
      general: 'Optimiza el código en general: rendimiento, legibilidad, y mejores prácticas',
      performance: 'Enfócate SOLO en optimizar el rendimiento y velocidad',
      readability: 'Enfócate SOLO en mejorar la legibilidad y mantenibilidad',
      security: 'Enfócate SOLO en aspectos de seguridad',
      memory: 'Enfócate SOLO en optimizar el uso de memoria',
    };

    const prompt = `${focusGuides[focus]}

Código ${language} a optimizar:

\`\`\`${language}
${code}
\`\`\`

Proporciona:
1. **Código optimizado** (completo y funcional)
2. **Cambios realizados** (lista breve)
3. **Mejora estimada** (si aplica: ej. "30% más rápido")`;

    return await this.generate(prompt);
  }

  async generateTests(code, language, framework = 'jest') {
    const prompt = `Genera tests unitarios completos para este código ${language}:

\`\`\`${language}
${code}
\`\`\`

Framework: ${framework}

Incluye:
1. Setup y imports necesarios
2. Tests para casos normales
3. Tests para edge cases
4. Tests para errores esperados

Tests completos y ejecutables.`;

    return await this.generate(prompt);
  }

  async explainCode(code, language, level = 'intermediate') {
    const levels = {
      beginner: 'Explica como si fuera para alguien que está aprendiendo a programar',
      intermediate: 'Explica de forma técnica pero clara',
      expert: 'Explica con detalles técnicos avanzados',
    };

    const prompt = `${levels[level]}

Código ${language}:

\`\`\`${language}
${code}
\`\`\`

Explica:
1. **Qué hace** (propósito general)
2. **Cómo funciona** (flujo paso a paso)
3. **Conceptos clave** (patrones, técnicas usadas)`;

    return await this.generate(prompt);
  }

  async refactorCode(code, language, style = 'modern') {
    const styles = {
      modern: 'ES6+, async/await, destructuring, arrow functions',
      functional: 'Programación funcional, inmutabilidad, composición',
      oop: 'Orientado a objetos, clases, herencia, encapsulación',
      clean: 'Clean Code principles, SOLID, nombres descriptivos',
    };

    const prompt = `Refactoriza este código ${language} usando estilo ${style}:
${styles[style]}

\`\`\`${language}
${code}
\`\`\`

Proporciona:
1. Código refactorizado completo
2. Explicación de los cambios`;

    return await this.generate(prompt);
  }
}

module.exports = AIEngine;
