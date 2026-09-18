const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { app } = require('electron');

class Database {
  constructor() {
    const dbPath = path.join(app.getPath('userData'), 'assistant.db');
    this.db = new sqlite3.Database(dbPath);
    // Se resuelve cuando el esquema está creado (el índice de documentación, que comparte
    // esta conexión, lo espera antes de crear sus tablas)
    this.ready = this.initialize();
  }

  initialize() {
    return new Promise(resolve => {
      this.db.serialize(() => {
        // Tabla de conversaciones
        this.db.run(`
          CREATE TABLE IF NOT EXISTS conversations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        // Tabla de mensajes
        this.db.run(`
          CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id INTEGER,
            role TEXT,
            content TEXT,
            sources TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (conversation_id) REFERENCES conversations (id)
          )
        `);

        // Caché de documentación por URL (sustituye a la antigua caché por pregunta, docs_cache)
        this.db.run(`DROP TABLE IF EXISTS docs_cache`);
        this.db.run(`
          CREATE TABLE IF NOT EXISTS docs_pages (
            url TEXT PRIMARY KEY,
            content TEXT,
            fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        // Índices para búsquedas rápidas
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_conversation ON messages(conversation_id)`);
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_title ON conversations(title)`);

        // En modo serialize, esta consulta se ejecuta después de todas las anteriores
        this.db.get('SELECT 1', () => resolve());
      });
    });
  }

  // Conversaciones con paginación y búsqueda
  getConversations(limit = 50, offset = 0, searchTerm = '') {
    return new Promise((resolve, reject) => {
      let query = 'SELECT * FROM conversations';
      let params = [];

      if (searchTerm) {
        query += ' WHERE title LIKE ?';
        params.push(`%${searchTerm}%`);
      }

      query += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);

      this.db.all(query, params, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  }

  // Contar conversaciones totales (con búsqueda opcional)
  getConversationsCount(searchTerm = '') {
    return new Promise((resolve, reject) => {
      let query = 'SELECT COUNT(*) as count FROM conversations';
      let params = [];

      if (searchTerm) {
        query += ' WHERE title LIKE ?';
        params.push(`%${searchTerm}%`);
      }

      this.db.get(query, params, (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row.count);
        }
      });
    });
  }

  createConversation(title) {
    return new Promise((resolve, reject) => {
      this.db.run('INSERT INTO conversations (title) VALUES (?)', [title], function (err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.lastID);
        }
      });
    });
  }

  deleteConversation(id) {
    return new Promise((resolve, reject) => {
      this.db.run('DELETE FROM conversations WHERE id = ?', [id], err => {
        if (err) {
          reject(err);
        } else {
          this.db.run('DELETE FROM messages WHERE conversation_id = ?', [id], err => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          });
        }
      });
    });
  }

  // Mensajes
  saveMessage(conversationId, role, content, sources = null) {
    return new Promise((resolve, reject) => {
      const sourcesJson = sources ? JSON.stringify(sources) : null;
      const db = this.db;
      this.db.run(
        'INSERT INTO messages (conversation_id, role, content, sources) VALUES (?, ?, ?, ?)',
        [conversationId, role, content, sourcesJson],
        function (err) {
          if (err) {
            reject(err);
          } else {
            const newId = this.lastID;
            db.run('UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [conversationId]);
            resolve(newId);
          }
        }
      );
    });
  }

  getMessages(conversationId) {
    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC',
        [conversationId],
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            const messages = rows.map(row => ({
              ...row,
              sources: row.sources ? JSON.parse(row.sources) : null,
            }));
            resolve(messages);
          }
        }
      );
    });
  }

  // Caché de documentación: contenido descargado por URL, válido 7 días
  getCachedPage(url) {
    return new Promise((resolve, reject) => {
      this.db.get(
        "SELECT content FROM docs_pages WHERE url = ? AND datetime(fetched_at, '+7 days') > datetime('now')",
        [url],
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(row ? row.content : null);
          }
        }
      );
    });
  }

  saveCachedPage(url, content) {
    return new Promise((resolve, reject) => {
      this.db.run('INSERT OR REPLACE INTO docs_pages (url, content) VALUES (?, ?)', [url, content], err => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  cleanOldCache() {
    return new Promise((resolve, reject) => {
      this.db.run("DELETE FROM docs_pages WHERE datetime(fetched_at, '+7 days') < datetime('now')", err => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  close() {
    this.db.close();
  }
}

module.exports = Database;
