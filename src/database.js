const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { app } = require('electron');

class Database {
  constructor() {
    const dbPath = path.join(app.getPath('userData'), 'assistant.db');
    this.db = new sqlite3.Database(dbPath);
    this.initialize();
  }

  initialize() {
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

      // Tabla de caché de documentación
      this.db.run(`
        CREATE TABLE IF NOT EXISTS docs_cache (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          query TEXT UNIQUE,
          results TEXT,
          source TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Índices para búsquedas rápidas
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_query ON docs_cache(query)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_conversation ON messages(conversation_id)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_title ON conversations(title)`);
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

  // Caché de documentación
  getCachedDocs(query) {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT * FROM docs_cache WHERE query = ? AND datetime(created_at, "+7 days") > datetime("now")',
        [query.toLowerCase()],
        (err, row) => {
          if (err) {
            reject(err);
          } else if (row) {
            resolve(JSON.parse(row.results));
          } else {
            resolve(null);
          }
        }
      );
    });
  }

  saveCachedDocs(query, results, source) {
    return new Promise((resolve, reject) => {
      this.db.run(
        'INSERT OR REPLACE INTO docs_cache (query, results, source) VALUES (?, ?, ?)',
        [query.toLowerCase(), JSON.stringify(results), source],
        err => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        }
      );
    });
  }

  cleanOldCache() {
    return new Promise((resolve, reject) => {
      this.db.run('DELETE FROM docs_cache WHERE datetime(created_at, "+30 days") < datetime("now")', err => {
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
