const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const Database = require('./src/database');
const DocsScraper = require('./src/scraper');
const AIEngine = require('./src/ai-engine');

let mainWindow;
let database;
let scraper;
let aiEngine;
let currentConversationId = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    autoHideMenuBar: true,
    backgroundColor: '#1e1e1e',
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
  database = new Database();
  scraper = new DocsScraper(database);
  aiEngine = new AIEngine();

  database.cleanOldCache();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (database) {
    database.close();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// === IPC Handlers ===

// Verificar estado de Ollama
ipcMain.handle('check-ollama', async () => {
  try {
    const status = await aiEngine.checkOllama();
    return { success: true, ...status };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Obtener modelos disponibles
ipcMain.handle('get-available-models', async () => {
  try {
    const models = aiEngine.getAvailableModels();
    return { success: true, models };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Cambiar modelo
ipcMain.handle('set-model', async (event, modelName) => {
  try {
    const result = await aiEngine.setModel(modelName);
    return result;
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Crear conversación
ipcMain.handle('create-conversation', async (event, title) => {
  try {
    currentConversationId = await database.createConversation(title || 'Nueva conversación');
    return { success: true, conversationId: currentConversationId };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Cargar conversación
ipcMain.handle('load-conversation', async (event, conversationId) => {
  try {
    currentConversationId = conversationId;
    const messages = await database.getMessages(conversationId);
    return { success: true, messages };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Eliminar conversación
ipcMain.handle('delete-conversation', async (event, conversationId) => {
  try {
    await database.deleteConversation(conversationId);
    if (currentConversationId === conversationId) {
      currentConversationId = null;
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Enviar mensaje (MEJORADO con IA)
ipcMain.handle('send-message', async (event, message) => {
  try {
    if (!currentConversationId) {
      const firstWords = message.split(' ').slice(0, 5).join(' ');
      currentConversationId = await database.createConversation(firstWords + '...');
    }

    // Guardar mensaje del usuario
    await database.saveMessage(currentConversationId, 'user', message);

    // Obtener contexto de la conversación
    const messages = await database.getMessages(currentConversationId);
    const context = messages.slice(-10).map(m => ({
      role: m.role,
      content: m.content,
    }));

    let answer = '';
    let sources = [];

    // Detectar si contiene código
    const codeInfo = scraper.extractCode(message);

    if (codeInfo) {
      console.log('Detectado codigo, analizando...');

      // Si hay código, analizar con IA
      const result = await aiEngine.analyzeCode(codeInfo.code, codeInfo.language, message);

      if (result.success) {
        answer = result.response;
      } else {
        answer = `Error al analizar el codigo: ${result.error}`;
      }
    } else {
      // Buscar en documentación primero (rápido)
      // console.log('📚 Buscando en documentación...');
      // const docsResults = await scraper.searchDocs(message, 2);
      // const docsContext = scraper.formatDocsForAI(docsResults);

      // sources = docsResults.map(r => ({
      //   title: r.title,
      //   url: r.url,
      //   source: r.source,
      // }));

      // Generar respuesta con IA + contexto de docs
      console.log('Generando respuesta con IA...');
      // const promptWithDocs = message + docsContext;
      const promptWithDocs = message;

      const result = await aiEngine.generate(promptWithDocs, context);

      if (result.success) {
        answer = result.response;

        // Añadir referencias a docs al final si hay
        if (sources.length > 0) {
          answer += '\n\n---\n\n**Referencias utiles:**\n';
          sources.forEach(s => {
            answer += `- [${s.title}](${s.url}) - ${s.source}\n`;
          });
        }
      } else {
        answer = `Error: ${result.error}\n\n¿Está Ollama corriendo? Ejecuta: \`ollama serve\``;
      }
    }

    // Guardar respuesta
    await database.saveMessage(currentConversationId, 'assistant', answer, sources);

    return {
      success: true,
      message: answer,
      sources,
      conversationId: currentConversationId,
    };
  } catch (error) {
    console.error('Error en send-message:', error);
    return {
      success: false,
      error: error.message,
    };
  }
});

// Generar código específico
ipcMain.handle('generate-code', async (event, { description, language }) => {
  try {
    const result = await aiEngine.generateCode(description, language);
    return result;
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Limpiar conversación actual
ipcMain.handle('clear-current-conversation', async () => {
  currentConversationId = null;
  return { success: true };
});

// Añade estos handlers después de los existentes

ipcMain.handle('optimize-code', async (event, { code, language, focus }) => {
  try {
    const result = await aiEngine.optimizeCode(code, language, focus);
    return result;
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('generate-tests', async (event, { code, language, framework }) => {
  try {
    const result = await aiEngine.generateTests(code, language, framework);
    return result;
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('explain-code', async (event, { code, language, level }) => {
  try {
    const result = await aiEngine.explainCode(code, language, level);
    return result;
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('refactor-code', async (event, { code, language, style }) => {
  try {
    const result = await aiEngine.refactorCode(code, language, style);
    return result;
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Obtener conversaciones con paginación y búsqueda
ipcMain.handle('get-conversations', async (event, options = {}) => {
  try {
    const { limit = 50, offset = 0, searchTerm = '' } = options;

    const conversations = await database.getConversations(limit, offset, searchTerm);
    const total = await database.getConversationsCount(searchTerm);

    return { success: true, conversations, total };
  } catch (error) {
    return { success: false, error: error.message };
  }
});
