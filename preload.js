const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Ollama/IA
  checkOllama: () => ipcRenderer.invoke('check-ollama'),
  getAvailableModels: () => ipcRenderer.invoke('get-available-models'),
  setModel: modelName => ipcRenderer.invoke('set-model', modelName),
  generateCode: data => ipcRenderer.invoke('generate-code', data),

  // Conversaciones
  createConversation: title => ipcRenderer.invoke('create-conversation', title),
  getConversations: options => ipcRenderer.invoke('get-conversations', options),
  loadConversation: id => ipcRenderer.invoke('load-conversation', id),
  deleteConversation: id => ipcRenderer.invoke('delete-conversation', id),
  clearCurrentConversation: () => ipcRenderer.invoke('clear-current-conversation'),

  // Mensajes
  sendMessage: message => ipcRenderer.invoke('send-message', message),

  optimizeCode: data => ipcRenderer.invoke('optimize-code', data),
  generateTests: data => ipcRenderer.invoke('generate-tests', data),
  explainCode: data => ipcRenderer.invoke('explain-code', data),
  refactorCode: data => ipcRenderer.invoke('refactor-code', data),
});
