const axios = require('axios');

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

  async generate(prompt, context = []) {
    try {
      const systemPrompt = `Eres un asistente experto en programación. Responde de forma directa y concisa.
      
REGLAS:
- Genera código limpio y funcional
- Usa \`\`\`javascript para bloques de código
- Sé breve, máximo 500 palabras
- Ve directo al punto`;

      let fullPrompt = systemPrompt + '\n\n';

      if (context.length > 0) {
        context.forEach(msg => {
          fullPrompt += `${msg.role === 'user' ? 'Usuario' : 'Asistente'}: ${msg.content}\n`;
        });
        fullPrompt += '\n';
      }

      fullPrompt += `Usuario: ${prompt}\n\nAsistente:`;

      const response = await axios.post(
        `${this.ollamaUrl}/api/generate`,
        {
          model: this.model,
          prompt: fullPrompt,
          stream: false,
          options: {
            temperature: 0.3,
            top_p: 0.9,
            top_k: 40,
            num_predict: 800,
          },
        },
        {
          timeout: 180000, // 3 minutos
        }
      );

      return {
        success: true,
        response: response.data.response,
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

  async analyzeCode(code, language, question = '') {
    const prompt = `Analiza este código ${language}:

\`\`\`${language}
${code}
\`\`\`

${question ? `Pregunta: ${question}` : 'Analiza el código'}

Responde brevemente con:
1. Qué hace
2. Errores (si hay)
3. Código mejorado`;

    return await this.generate(prompt);
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
