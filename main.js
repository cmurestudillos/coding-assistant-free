const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const Database = require('./src/database');
const DocsScraper = require('./src/scraper');
const DocsIndex = require('./src/docs-index');
const AIEngine = require('./src/ai-engine');

let mainWindow;
let database;
let scraper;
let docsIndex;
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

  // Abrir los enlaces (fuentes de documentación) en el navegador del sistema
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
  database = new Database();
  aiEngine = new AIEngine();
  docsIndex = new DocsIndex(database.db, database.ready, aiEngine);
  scraper = new DocsScraper(database, docsIndex);

  database.cleanOldCache();
  createWindow();

  // Cargar el modelo en segundo plano para que la primera pregunta no espere a la carga en frío
  aiEngine.warmUp();

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

// Fuentes de documentación disponibles (para el selector de la interfaz)
ipcMain.handle('get-docs-sources', async () => {
  return { success: true, sources: scraper.getSources() };
});

// === Documentación offline (paquetes DevDocs) ===

ipcMain.handle('docs-packs-list', async () => {
  try {
    return { success: true, ...(await docsIndex.listPacks()) };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// El progreso se envía con el evento 'docs-pack-progress' mientras dura la instalación
ipcMain.handle('docs-pack-install', async (event, key) => {
  let lastProgress = '';
  const sendProgress = progress => {
    const current = `${progress.phase}:${progress.percent}`;
    if (current !== lastProgress && !event.sender.isDestroyed()) {
      lastProgress = current;
      event.sender.send('docs-pack-progress', { key, ...progress });
    }
  };

  try {
    const result = await docsIndex.install(key, sendProgress);
    return { success: true, ...result };
  } catch (error) {
    console.error(`Error instalando documentación ${key}:`, error.message);
    return { success: false, error: error.message };
  }
});

// Generar los embeddings (búsqueda semántica) de un paquete ya instalado
ipcMain.handle('docs-pack-embed', async (event, key) => {
  try {
    await docsIndex.embedPack(key, progress => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('docs-pack-progress', { key, ...progress });
      }
    });
    return { success: true };
  } catch (error) {
    console.error(`Error generando embeddings de ${key}:`, error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('docs-pack-remove', async (event, key) => {
  try {
    await docsIndex.remove(key);
    return { success: true };
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
// options.technology: fuente de documentación elegida en la interfaz ('' = automática, 'none' = sin docs)
ipcMain.handle('send-message', async (event, message, options = {}) => {
  try {
    if (!currentConversationId) {
      const firstWords = message.split(' ').slice(0, 5).join(' ');
      currentConversationId = await database.createConversation(firstWords + '...');
    }

    // Guardar mensaje del usuario
    await database.saveMessage(currentConversationId, 'user', message);

    // Historial previo de la conversación (sin el mensaje recién guardado, que se envía aparte)
    const messages = await database.getMessages(currentConversationId);
    const history = messages.slice(-11, -1).map(m => ({
      role: m.role,
      content: m.content,
    }));

    let answer = '';
    let sources = [];
    let docsContext = '';

    // Buscar en la documentación oficial con términos en inglés. También con código:
    // la IA extrae las APIs que usa (p. ej. "useEffect", "fs.readFile")
    if (options.technology !== 'none') {
      console.log('📚 Buscando en documentación...');
      const searchQuery = await aiEngine.extractSearchQuery(message);
      const docsResults = await scraper.searchDocs(message, { searchQuery, technology: options.technology });
      docsContext = scraper.formatDocsForAI(docsResults);
      sources = scraper.toSources(docsResults);
    }

    // Detectar si contiene código
    const codeInfo = scraper.extractCode(message);

    if (codeInfo) {
      console.log('Detectado codigo, analizando...');

      // Si hay código, analizar con IA
      const result = await aiEngine.analyzeCode(codeInfo.code, codeInfo.language, message, docsContext);

      if (result.success) {
        answer = result.response;
      } else {
        answer = `Error al analizar el codigo: ${result.error}`;
      }
    } else {
      // Generar respuesta con IA + contexto de docs
      console.log('Generando respuesta con IA...');
      const result = await aiEngine.generate(message, history, docsContext);

      if (result.success) {
        // Las fuentes se muestran numeradas en la interfaz, a partir de "sources"
        answer = result.response;
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
