// Estado de la aplicación
let currentConversationId = null;
let conversations = [];
let ollamaRunning = false;
let currentModel = 'qwen2.5-coder:3b';

// Variables para reintentos
let lastFailedMessage = null;
let retryCount = 0;
const MAX_RETRIES = 3;

// Variables para paginación y búsqueda
let conversationsLimit = 50;
let conversationsOffset = 0;
let totalConversations = 0;
let loadingMore = false;
let searchTerm = '';
let searchTimeout = null;

// Elementos DOM
const chatContainer = document.getElementById('chatContainer');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const sendBtnText = document.getElementById('sendBtnText');
const sendBtnLoader = document.getElementById('sendBtnLoader');
const newChatBtn = document.getElementById('newChatBtn');
const cacheStatus = document.getElementById('cacheStatus');

// Event Listeners básicos
sendBtn.addEventListener('click', () => sendMessage(false));
messageInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage(false);
  }
});

newChatBtn.addEventListener('click', createNewConversation);

// Settings
const settingsBtn = document.getElementById('settingsBtn');
const settingsModal = document.getElementById('settingsModal');
const closeSettingsModal = document.getElementById('closeSettingsModal');
const modelSelect = document.getElementById('modelSelect');

if (settingsBtn) {
  settingsBtn.addEventListener('click', openSettings);
}
if (closeSettingsModal) {
  closeSettingsModal.addEventListener('click', closeSettings);
}
if (settingsModal) {
  settingsModal.addEventListener('click', e => {
    if (e.target === settingsModal) {
      closeSettings();
    }
  });
}
if (modelSelect) {
  modelSelect.addEventListener('change', async e => {
    const modelName = e.target.value;
    if (modelName) {
      await changeModel(modelName);
    }
  });
}

// Clicks en ejemplos
document.addEventListener('click', e => {
  if (e.target.classList.contains('example-q')) {
    messageInput.value = e.target.textContent;
    sendMessage(false);
  }
});

// Botones de acción rápida
document.addEventListener('click', e => {
  if (e.target.classList.contains('quick-btn')) {
    const action = e.target.dataset.action;
    const code = messageInput.value.trim();

    if (!code) {
      alert('Por favor, pega tu código primero');
      return;
    }

    let prompt = '';

    switch (action) {
      case 'optimize':
        prompt = `Optimiza y mejora este código:\n\n${code}\n\nProporciona:\n1. Código optimizado\n2. Explicación de las mejoras\n3. Comparación de rendimiento`;
        break;
      case 'explain':
        prompt = `Explica detalladamente qué hace este código:\n\n${code}\n\nIncluye:\n1. Propósito general\n2. Línea por línea\n3. Casos de uso`;
        break;
      case 'fix':
        prompt = `Analiza este código y encuentra/corrige errores:\n\n${code}\n\nBusca:\n1. Errores de sintaxis\n2. Errores lógicos\n3. Malas prácticas\n4. Posibles bugs`;
        break;
      case 'test':
        prompt = `Genera tests unitarios para este código:\n\n${code}\n\nGenera tests con:\n1. Jest o Vitest\n2. Casos edge\n3. Mocks si es necesario`;
        break;
    }

    messageInput.value = prompt;
    sendMessage(false);
  }
});

// Event listeners adicionales
document.addEventListener('DOMContentLoaded', () => {
  const loadMoreBtn = document.getElementById('loadMoreBtn');
  const searchInput = document.getElementById('conversationSearch');

  if (loadMoreBtn) {
    loadMoreBtn.addEventListener('click', () => {
      loadConversations(true);
    });
  }

  if (searchInput) {
    searchInput.addEventListener('input', e => {
      // Debounce para no buscar en cada tecla
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        searchTerm = e.target.value.trim();
        conversationsOffset = 0;
        loadConversations(false);
      }, 300); // Esperar 300ms después de dejar de escribir
    });
  }
});

// === FUNCIONES PRINCIPALES ===

// Función mejorada con reintentos
async function sendMessage(isRetry = false) {
  const message = isRetry ? lastFailedMessage : messageInput.value.trim();
  if (!message) {
    return;
  }

  // Si no es reintento, guardar el mensaje por si falla
  if (!isRetry) {
    lastFailedMessage = message;
    retryCount = 0;
  }

  // Deshabilitar input
  messageInput.disabled = true;
  sendBtn.disabled = true;
  sendBtnText.style.display = 'none';
  sendBtnLoader.style.display = 'block';

  // Limpiar welcome si existe
  const welcomeMsg = chatContainer.querySelector('.welcome-message');
  if (welcomeMsg) {
    welcomeMsg.remove();
  }

  // Mostrar mensaje del usuario (solo si no es reintento)
  if (!isRetry) {
    addMessage(message, 'user');
    messageInput.value = '';
  }

  try {
    const result = await window.electronAPI.sendMessage(message);

    if (result.success) {
      addMessage(result.message, 'assistant', result.sources);

      // Actualizar conversación actual
      if (result.conversationId) {
        currentConversationId = result.conversationId;
        await loadConversations();
      }

      // Limpiar mensaje guardado si tuvo éxito
      lastFailedMessage = null;
      retryCount = 0;
    } else {
      // Error - mostrar mensaje con opción de reintentar
      handleMessageError(result.error, message);
    }
  } catch (error) {
    handleMessageError(error.message, message);
  } finally {
    messageInput.disabled = false;
    sendBtn.disabled = false;
    sendBtnText.style.display = 'block';
    sendBtnLoader.style.display = 'none';
    messageInput.focus();
  }
}

// Manejar errores con opciones de reintento
function handleMessageError(errorMessage, _originalMessage) {
  retryCount++;

  let errorType = 'general';
  let userFriendlyError = '';
  let suggestion = '';

  // Detectar tipo de error
  if (errorMessage.includes('timeout')) {
    errorType = 'timeout';
    userFriendlyError = '**La respuesta tardó demasiado**';
    suggestion = 'El modelo puede estar sobrecargado. Intenta de nuevo o usa una pregunta más corta.';
  } else if (
    errorMessage.includes('Ollama no está corriendo') ||
    errorMessage.includes('ECONNREFUSED') ||
    errorMessage.includes('conectar con Ollama')
  ) {
    errorType = 'connection';
    userFriendlyError = '**Ollama no está conectado**';
    suggestion = 'Asegúrate de que Ollama está corriendo. Abre una terminal y ejecuta: `ollama serve`';
  } else if (errorMessage.includes('model')) {
    errorType = 'model';
    userFriendlyError = '**Error con el modelo de IA**';
    suggestion = 'El modelo puede no estar descargado. Verifica en Configuración';
  } else {
    userFriendlyError = '**Error inesperado**';
    suggestion = errorMessage;
  }

  // Crear mensaje de error con opciones
  const errorDiv = document.createElement('div');
  errorDiv.className = 'message message-assistant';

  const contentDiv = document.createElement('div');
  contentDiv.className = 'message-content error-message';

  contentDiv.innerHTML = `
    ${userFriendlyError}
    
    ${suggestion}
    
    ---
    
    **Intento ${retryCount} de ${MAX_RETRIES}**
    
    <div class="error-actions">
      ${retryCount < MAX_RETRIES ? '<button class="btn btn-retry" onclick="retryLastMessage()">Reintentar</button>' : ''}
      <button class="btn btn-edit" onclick="editFailedMessage()">Editar mensaje</button>
      <button class="btn btn-cancel" onclick="cancelRetry()">Cancelar</button>
    </div>
    
    <details style="margin-top: 15px;">
      <summary style="cursor: pointer; color: var(--text-secondary); font-size: 12px;">Ver error técnico</summary>
      <pre style="font-size: 11px; margin-top: 10px; padding: 10px; background: #f5f5f5; border-radius: 4px;">${escapeHtml(errorMessage)}</pre>
    </details>
  `;

  errorDiv.appendChild(contentDiv);
  chatContainer.appendChild(errorDiv);
  chatContainer.scrollTop = chatContainer.scrollHeight;

  // Auto-reintentar después de 3 segundos para timeouts (solo primer intento)
  if (errorType === 'timeout' && retryCount === 1) {
    let countdown = 3;
    const countdownInterval = setInterval(() => {
      const retryBtn = document.querySelector('.btn-retry');
      if (retryBtn) {
        retryBtn.textContent = `Reintentando en ${countdown}s...`;
        countdown--;

        if (countdown < 0) {
          clearInterval(countdownInterval);
          window.retryLastMessage();
        }
      } else {
        clearInterval(countdownInterval);
      }
    }, 1000);
  }
}

// Reintentar último mensaje
window.retryLastMessage = function () {
  if (!lastFailedMessage) {
    alert('No hay mensaje para reintentar');
    return;
  }

  // Eliminar mensajes de error anteriores
  const errorMessages = chatContainer.querySelectorAll('.error-message');
  errorMessages.forEach(msg => msg.parentElement.remove());

  // Enviar de nuevo
  sendMessage(true);
};

// Editar mensaje fallido
window.editFailedMessage = function () {
  if (!lastFailedMessage) {
    alert('No hay mensaje para editar');
    return;
  }

  messageInput.value = lastFailedMessage;
  messageInput.focus();

  // Eliminar mensajes de error
  const errorMessages = chatContainer.querySelectorAll('.error-message');
  errorMessages.forEach(msg => msg.parentElement.remove());

  // Limpiar estado
  lastFailedMessage = null;
  retryCount = 0;
};

// Cancelar reintento
window.cancelRetry = function () {
  lastFailedMessage = null;
  retryCount = 0;

  // Eliminar mensajes de error
  const errorMessages = chatContainer.querySelectorAll('.error-message');
  errorMessages.forEach(msg => msg.parentElement.remove());

  messageInput.focus();
};

function addMessage(content, role, sources = null) {
  const messageDiv = document.createElement('div');
  messageDiv.className = `message message-${role}`;

  const contentDiv = document.createElement('div');
  contentDiv.className = 'message-content';

  // Formatear contenido con markdown básico
  const formattedContent = formatMessage(content);
  contentDiv.innerHTML = formattedContent;

  // Agregar fuentes si existen
  if (sources && sources.length > 0) {
    const sourcesDiv = document.createElement('div');
    sourcesDiv.className = 'message-sources';
    sourcesDiv.innerHTML = '<strong>Fuentes consultadas:</strong>';

    sources.forEach(source => {
      const sourceItem = document.createElement('div');
      sourceItem.className = 'source-item';
      sourceItem.innerHTML = `
        <span class="source-badge">${source.source}</span>
        <a href="${source.url}" target="_blank">${source.title}</a>
      `;
      sourcesDiv.appendChild(sourceItem);
    });

    contentDiv.appendChild(sourcesDiv);
  }

  messageDiv.appendChild(contentDiv);
  chatContainer.appendChild(messageDiv);
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function formatMessage(text) {
  // Convertir headers markdown
  text = text.replace(/^### (.*$)/gim, '<h3>$1</h3>');
  text = text.replace(/^## (.*$)/gim, '<h3>$1</h3>');

  // Convertir negrita
  text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

  // Convertir bloques de código
  text = text.replace(/```(\w+)?\n([\s\S]*?)```/g, (match, lang, code) => {
    return `<pre><code class="language-${lang || 'javascript'}">${escapeHtml(code.trim())}</code></pre>`;
  });

  // Convertir código inline
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Convertir links
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

  // Convertir saltos de línea
  text = text.replace(/\n/g, '<br>');

  // Convertir separadores
  text = text.replace(/---/g, '<hr>');

  return text;
}

function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}

async function createNewConversation() {
  await window.electronAPI.clearCurrentConversation();
  currentConversationId = null;

  chatContainer.innerHTML = `
    <div class="welcome-message">
      <div class="welcome-icon">💻</div>
      <h2>Nueva Conversación</h2>
      <p>¿En qué puedo ayudarte hoy?</p>
    </div>
  `;

  await loadConversations();
  messageInput.focus();
}

// Función actualizada de loadConversations con paginación y búsqueda
async function loadConversations(loadMore = false) {
  if (loadingMore) {
    return;
  }

  try {
    if (!loadMore) {
      conversationsOffset = 0;
      conversations = [];
    }

    loadingMore = true;

    // Mostrar indicador de carga
    const conversationsList = document.getElementById('conversationsList');
    if (conversationsList) {
      conversationsList.classList.add('loading');
    }

    const result = await window.electronAPI.getConversations({
      limit: conversationsLimit,
      offset: conversationsOffset,
      searchTerm: searchTerm,
    });

    if (result.success) {
      if (loadMore) {
        conversations = [...conversations, ...result.conversations];
      } else {
        conversations = result.conversations;
      }

      totalConversations = result.total;
      conversationsOffset += result.conversations.length;

      renderConversations();
      updateCacheStatus();
      updateLoadMoreButton();
    }
  } catch (error) {
    console.error('Error loading conversations:', error);
  } finally {
    loadingMore = false;

    const conversationsList = document.getElementById('conversationsList');
    if (conversationsList) {
      conversationsList.classList.remove('loading');
    }
  }
}

// Función para actualizar botón "Cargar más"
function updateLoadMoreButton() {
  const loadMoreContainer = document.getElementById('loadMoreContainer');
  const loadMoreBtn = document.getElementById('loadMoreBtn');
  const loadMoreInfo = document.getElementById('loadMoreInfo');

  if (!loadMoreContainer || !loadMoreBtn || !loadMoreInfo) {
    return;
  }

  const hasMore = conversations.length < totalConversations;

  if (hasMore && conversations.length > 0) {
    loadMoreContainer.style.display = 'block';
    const remaining = totalConversations - conversations.length;
    loadMoreInfo.textContent = `Mostrando ${conversations.length} de ${totalConversations} (${remaining} más)`;
  } else {
    loadMoreContainer.style.display = 'none';
  }

  loadMoreBtn.disabled = loadingMore;
  loadMoreBtn.textContent = loadingMore ? 'Cargando...' : 'Cargar más';
}

function renderConversations() {
  const conversationsList = document.getElementById('conversationsList');

  if (conversations.length === 0) {
    if (searchTerm) {
      // Sin resultados de búsqueda
      conversationsList.innerHTML = `
        <div class="no-results">
          <div class="no-results-icon">🔍</div>
          <p><strong>No se encontraron resultados</strong></p>
          <small>Intenta con otros términos de búsqueda</small>
        </div>
      `;
    } else {
      // Sin conversaciones
      conversationsList.innerHTML = `
        <div class="empty-state">
          <p>Sin conversaciones</p>
          <small>Inicia una nueva conversación</small>
        </div>
      `;
    }
    return;
  }

  conversationsList.innerHTML = '';

  conversations.forEach(conv => {
    const convDiv = document.createElement('div');
    convDiv.className = 'conversation-item';
    if (conv.id === currentConversationId) {
      convDiv.classList.add('active');
    }

    const date = new Date(conv.updated_at);
    const dateStr = formatDate(conv.updated_at);

    // Fecha completa para el tooltip
    const fullDate = date.toLocaleString('es-ES', {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

    // Resaltar término de búsqueda en el título
    let displayTitle = escapeHtml(conv.title);
    if (searchTerm) {
      const escapedTerm = escapeHtml(searchTerm).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(${escapedTerm})`, 'gi');
      displayTitle = displayTitle.replace(regex, '<mark>$1</mark>');
    }

    convDiv.innerHTML = `
      <div style="flex: 1; overflow: hidden;">
        <div class="conversation-title">${displayTitle}</div>
        <div class="conversation-date" title="${fullDate}">${dateStr}</div>
      </div>
      <button class="delete-btn" data-id="${conv.id}" title="Eliminar">⛔</button>
    `;

    convDiv.addEventListener('click', async e => {
      if (!e.target.classList.contains('delete-btn')) {
        await loadConversation(conv.id);
      }
    });

    const deleteBtn = convDiv.querySelector('.delete-btn');
    deleteBtn.addEventListener('click', async e => {
      e.stopPropagation();
      if (confirm('¿Eliminar esta conversación?')) {
        await deleteConversation(conv.id);
      }
    });

    conversationsList.appendChild(convDiv);
  });
}

async function loadConversation(id) {
  try {
    const result = await window.electronAPI.loadConversation(id);

    if (result.success) {
      currentConversationId = id;
      chatContainer.innerHTML = '';

      result.messages.forEach(msg => {
        addMessage(msg.content, msg.role, msg.sources);
      });

      await loadConversations();
    }
  } catch (error) {
    console.error('Error loading conversation:', error);
  }
}

async function deleteConversation(id) {
  try {
    const result = await window.electronAPI.deleteConversation(id);

    if (result.success) {
      if (currentConversationId === id) {
        await createNewConversation();
      }

      // Recargar conversaciones manteniendo búsqueda
      conversationsOffset = 0;
      await loadConversations(false);
    }
  } catch (error) {
    console.error('Error deleting conversation:', error);
  }
}

function formatDate(dateString) {
  const date = new Date(dateString);
  const now = new Date();

  if (isNaN(date.getTime())) {
    return 'Fecha inválida';
  }

  const diffMs = now - date;
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMs < 0) {
    return 'Recién creada';
  }

  if (diffSecs < 10) {
    return 'Ahora mismo';
  }
  if (diffSecs < 30) {
    return 'Hace unos segundos';
  }
  if (diffSecs < 60) {
    return 'Hace menos de 1min';
  }

  if (diffMins === 1) {
    return 'Hace 1min';
  }
  if (diffMins < 60) {
    return `Hace ${diffMins}min`;
  }

  if (diffHours === 1) {
    return 'Hace 1h';
  }
  if (diffHours < 24) {
    return `Hace ${diffHours}h`;
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return `Ayer ${date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`;
  }

  if (diffDays < 7) {
    const dayNames = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    return dayNames[date.getDay()];
  }

  if (diffDays < 30) {
    const weeks = Math.floor(diffDays / 7);
    return weeks === 1 ? 'Hace 1 semana' : `Hace ${weeks} semanas`;
  }

  if (diffDays < 365) {
    const months = Math.floor(diffDays / 30);
    return months === 1 ? 'Hace 1 mes' : `Hace ${months} meses`;
  }

  return date.toLocaleDateString('es-ES', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function updateCacheStatus() {
  const count = conversations.length;
  const ollamaStatus = ollamaRunning ? '🟢 IA Activa' : '🔴 IA Inactiva';
  cacheStatus.textContent = `${ollamaStatus} | ${count} conversaciones`;
}

// Funciones de configuración
async function openSettings() {
  settingsModal.classList.add('active');
  await checkOllamaStatus();
  await loadAvailableModels();
}

function closeSettings() {
  settingsModal.classList.remove('active');
}

async function checkOllamaStatus() {
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const installGuide = document.getElementById('installationGuide');

  try {
    const result = await window.electronAPI.checkOllama();

    if (result.running) {
      ollamaRunning = true;
      statusDot.className = 'status-dot running';
      statusText.textContent = 'Ollama está corriendo';
      installGuide.style.display = 'none';

      if (result.models && result.models.length > 0) {
        statusText.textContent += ` - ${result.models.length} modelo(s) instalado(s)`;
      }
    } else {
      ollamaRunning = false;
      statusDot.className = 'status-dot stopped';
      statusText.textContent = 'Ollama no está corriendo';
      installGuide.style.display = 'block';
    }
  } catch (_error) {
    ollamaRunning = false;
    statusDot.className = 'status-dot stopped';
    statusText.textContent = 'Error al verificar Ollama';
    installGuide.style.display = 'block';
  }

  updateCacheStatus();
}

async function loadAvailableModels() {
  try {
    const result = await window.electronAPI.getAvailableModels();

    if (result.success) {
      modelSelect.innerHTML = '';

      result.models.forEach(model => {
        const option = document.createElement('option');
        option.value = model.name;
        option.textContent = `${model.description} (${model.size})`;
        modelSelect.appendChild(option);
      });

      modelSelect.value = currentModel;
    }
  } catch (error) {
    console.error('Error loading models:', error);
  }
}

async function changeModel(modelName) {
  const statusText = document.getElementById('statusText');
  try {
    statusText.textContent = 'Cambiando modelo...';

    const result = await window.electronAPI.setModel(modelName);

    if (result.success) {
      currentModel = modelName;
      statusText.textContent = `Modelo cambiado a: ${modelName}`;
    } else {
      statusText.textContent = `Error: ${result.error}`;
    }
  } catch (_error) {
    statusText.textContent = `Error cambiando modelo`;
  }
}

// Inicializar
window.addEventListener('DOMContentLoaded', async () => {
  await loadConversations();
  await checkOllamaStatus();
  messageInput.focus();
});
