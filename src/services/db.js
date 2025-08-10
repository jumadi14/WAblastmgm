// src/services/db.js

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs-extra');

const DB_FILENAME = 'messages.db';
const DB_PATH = path.join(process.cwd(), 'database', DB_FILENAME);

let db = null;
let dbReadyPromise = null;

/**
 * Menghubungkan ke database SQLite dan memastikan tabel-tabel yang diperlukan sudah ada.
 * Menggunakan fs-extra untuk memastikan direktori database ada.
 * @returns {Promise<sqlite3.Database>} Sebuah promise yang mengembalikan instance database saat siap.
 */
const _connectAndInitialize = () => {
    return new Promise((resolve, reject) => {
        fs.ensureDir(path.dirname(DB_PATH)).then(() => {
            console.log(`Database directory created/ensured at: ${path.dirname(DB_PATH)}`);
            db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
                if (err) {
                    console.error('Error opening database:', err.message);
                    return reject(err);
                }
                console.log(`Connected to the SQLite database: ${DB_FILENAME}.`);
                const tableStatements = [
                    `
                    CREATE TABLE IF NOT EXISTS devices (
                        name TEXT PRIMARY KEY,
                        status TEXT,
                        phoneNumber TEXT,
                        qrCode TEXT,
                        error TEXT,
                        lastUpdated DATETIME DEFAULT CURRENT_TIMESTAMP
                    )`,
                    `
                    CREATE TABLE IF NOT EXISTS incoming_messages (
                        id TEXT PRIMARY KEY,
                        deviceName TEXT NOT NULL,
                        fromNumber TEXT NOT NULL,
                        toNumber TEXT,
                        type TEXT,
                        body TEXT,
                        timestamp DATETIME,
                        isGroup BOOLEAN,
                        senderName TEXT,
                        chatId TEXT,
                        status TEXT DEFAULT 'unread',
                        receivedAt DATETIME DEFAULT CURRENT_TIMESTAMP
                    )`,
                    `
                    CREATE TABLE IF NOT EXISTS outgoing_messages (
                        id TEXT PRIMARY KEY,
                        deviceName TEXT NOT NULL,
                        toNumber TEXT NOT NULL,
                        message TEXT,
                        mediaPath TEXT,
                        status TEXT,
                        error TEXT,
                        timestamp DATETIME,
                        sentAt DATETIME DEFAULT CURRENT_TIMESTAMP
                    )`,
                    `
                    CREATE TABLE IF NOT EXISTS templates (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        name TEXT UNIQUE NOT NULL,
                        content TEXT NOT NULL,
                        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
                    )`
                ];
                let completedTables = 0;
                const totalTables = tableStatements.length;
                tableStatements.forEach((sql, index) => {
                    db.run(sql, (err) => {
                        if (err) {
                            console.error(`Error creating table (statement ${index + 1}):`, err.message);
                        } else {
                            console.log(`Table ${index + 1} checked/created.`);
                        }
                        completedTables++;
                        if (completedTables === totalTables) {
                            resolve(db);
                        }
                    });
                });
            });
        }).catch(err => {
            console.error('Error ensuring database directory exists or connecting:', err);
            reject(err);
        });
    });
};

dbReadyPromise = _connectAndInitialize();

/**
 * Mengembalikan promise yang akan resolve saat database siap digunakan.
 * @returns {Promise<sqlite3.Database>}
 */
const getDbInstance = () => {
    return dbReadyPromise;
};

// --- Fungsi-fungsi CRUD Devices ---

/**
 * Mengambil semua perangkat dari database.
 * @returns {Promise<Array<Object>>}
 */
const getDevices = () => {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error('Database not yet ready.'));
        db.all("SELECT * FROM devices", [], (err, rows) => {
            if (err) { reject(err); } else { resolve(rows); }
        });
    });
};

/**
 * Mengambil satu perangkat berdasarkan nama.
 * @param {string} name - Nama perangkat.
 * @returns {Promise<Object>}
 */
const getDeviceByName = (name) => {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error('Database not yet ready.'));
        db.get("SELECT * FROM devices WHERE name = ?", [name], (err, row) => {
            if (err) { reject(err); } else { resolve(row); }
        });
    });
};

/**
 * Menambahkan atau memperbarui perangkat.
 * @param {Object} device - Objek perangkat yang berisi name, status, phoneNumber, qrCode, error.
 * @returns {Promise<Object>}
 */
const addOrUpdateDevice = async (device) => {
    if (!db) throw new Error('Database not yet ready.');
    const existingDevice = await getDeviceByName(device.name);
    if (existingDevice) {
        return new Promise((resolve, reject) => {
            db.run(`UPDATE devices SET status = ?, phoneNumber = ?, qrCode = ?, error = ?, lastUpdated = CURRENT_TIMESTAMP WHERE name = ?`, [device.status, device.phoneNumber, device.qrCode, device.error, device.name], function(err) {
                if (err) { reject(err); } else { resolve({...device, changes: this.changes }); }
            });
        });
    } else {
        return new Promise((resolve, reject) => {
            db.run(`INSERT INTO devices (name, status, phoneNumber, qrCode, error) VALUES (?, ?, ?, ?, ?)`, [device.name, device.status, device.phoneNumber, device.qrCode, device.error], function(err) {
                if (err) { reject(err); } else { resolve({...device, id: this.lastID }); }
            });
        });
    }
};

/**
 * Memperbarui status perangkat yang sudah ada atau membuat yang baru jika belum ada.
 * @param {string} deviceName - Nama perangkat.
 * @param {string} status - Status baru.
 * @param {string} phoneNumber - Nomor telepon perangkat (opsional).
 * @param {string} qrCode - Kode QR (opsional).
 * @param {string} error - Pesan error (opsional).
 * @returns {Promise<Object>}
 */
const updateDeviceStatus = async(deviceName, status, phoneNumber = null, qrCode = null, error = null) => {
    if (!db) throw new Error('Database not yet ready.');
    const existingDevice = await getDeviceByName(deviceName);
    const finalQrCode = qrCode === undefined ? null : qrCode;
    const finalPhoneNumber = phoneNumber === undefined ? null : phoneNumber;
    const finalError = error === undefined ? null : error;
    if (existingDevice) {
        return new Promise((resolve, reject) => {
            db.run(`UPDATE devices SET status = ?, phoneNumber = ?, qrCode = ?, error = ?, lastUpdated = CURRENT_TIMESTAMP WHERE name = ?`, [status, finalPhoneNumber, finalQrCode, finalError, deviceName], function(err) {
                if (err) { reject(err); } else { resolve({ deviceName, status, phoneNumber: finalPhoneNumber, qrCode: finalQrCode, error: finalError, changes: this.changes }); }
            });
        });
    } else {
        return new Promise((resolve, reject) => {
            db.run(`INSERT INTO devices (name, status, phoneNumber, qrCode, error) VALUES (?, ?, ?, ?, ?)`, [deviceName, status, finalPhoneNumber, finalQrCode, finalError], function(err) {
                if (err) { reject(err); } else { resolve({ deviceName, status, phoneNumber: finalPhoneNumber, qrCode: finalQrCode, error: finalError, id: this.lastID }); }
            });
        });
    }
};

/**
 * Menghapus perangkat berdasarkan nama.
 * @param {string} deviceName - Nama perangkat.
 * @returns {Promise<Object>}
 */
const removeDevice = (deviceName) => {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error('Database not yet ready.'));
        db.run(`DELETE FROM devices WHERE name = ?`, [deviceName], function(err) {
            if (err) { reject(err); } else { resolve({ deleted: this.changes }); }
        });
    });
};

// --- Fungsi-fungsi CRUD Outgoing Messages ---

/**
 * Menyimpan pesan keluar ke database.
 * @param {Object} messageData - Objek data pesan keluar.
 * @returns {Promise<Object>}
 */
const saveOutgoingMessage = (messageData) => {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error('Database not yet ready.'));
        const { id, deviceName, toNumber, message, mediaPath, status = 'pending', timestamp } = messageData;
        db.run(`INSERT INTO outgoing_messages (id, deviceName, toNumber, message, mediaPath, status, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)`, [id, deviceName, toNumber, message, mediaPath, status, timestamp], function(err) {
            if (err) { reject(err); } else { resolve({ ...messageData, dbId: this.lastID }); }
        });
    });
};

/**
 * Mengambil pesan keluar dengan opsi filter, limit, dan offset.
 * @param {Object} [options] - Opsi-opsi filter.
 * @param {string|Array<string>} [options.status] - Status pesan yang ingin difilter. Bisa berupa string (koma-separated) atau array.
 * @param {string} [options.deviceName] - Nama perangkat untuk difilter.
 * @param {number} [options.limit] - Jumlah data yang akan diambil.
 * @param {number} [options.offset=0] - Offset untuk pagination.
 * @returns {Promise<Array<Object>>}
 */
const getOutgoingMessages = ({ status, deviceName, limit, offset = 0 } = {}) => {
    return new Promise((resolve, reject) => {
    let query = 'SELECT id, deviceName, toNumber, message, status, timestamp, mediaPath FROM outgoing_messages';
        if (!db) return reject(new Error('Database not yet ready.'));

        let sql = `SELECT * FROM outgoing_messages`;
        const params = [];
        const whereClauses = [];

        // --- PERBAIKAN: Tangani status sebagai array atau string ---
        let statusArray = [];
        if (Array.isArray(status)) {
            statusArray = status;
        } else if (typeof status === 'string' && status.length > 0) {
            statusArray = status.split(',');
        }

        if (statusArray.length > 0) {
            const placeholders = statusArray.map(() => '?').join(',');
            whereClauses.push(`status IN (${placeholders})`);
            params.push(...statusArray);
        }
        // --- AKHIR PERBAAIKAN ---
        
        // Logika untuk menangani filter perangkat
        if (deviceName) {
            whereClauses.push(`deviceName = ?`);
            params.push(deviceName);
        }

        // Gabungkan klausa WHERE jika ada
        if (whereClauses.length > 0) {
            sql += ` WHERE ` + whereClauses.join(' AND ');
        }

        sql += ` ORDER BY timestamp DESC`;

        // Tambahkan LIMIT jika nilainya ditentukan
        if (limit) {
            sql += ` LIMIT ? OFFSET ?`;
            params.push(limit, offset);
        }

        console.log("Executing SQL Query:", sql, "with params:", params);
        
        db.all(sql, params, (err, rows) => {
            if (err) {
                console.error("Error fetching messages:", err);
                reject(err);
            } else {
                resolve(rows);
            }
        });
    });
};

/**
 * Mengambil pesan keluar berdasarkan ID.
 * @param {string} id - ID pesan.
 * @returns {Promise<Object>}
 */
const getOutgoingMessageById = (id) => {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error('Database not yet ready.'));
        db.get(`SELECT * FROM outgoing_messages WHERE id = ?`, [id], (err, row) => {
            if (err) { reject(err); } else { resolve(row); }
        });
    });
};

/**
 * Memperbarui status pesan keluar.
 * @param {string} id - ID pesan.
 * @param {string} status - Status baru.
 * @param {string} [error] - Pesan error (opsional).
 * @returns {Promise<Object>}
 */
const updateOutgoingMessageStatus = (id, status, error = null) => {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error('Database not yet ready.'));
        db.run(`UPDATE outgoing_messages SET status = ?, error = ?, sentAt = CURRENT_TIMESTAMP WHERE id = ?`, [status, error, id], function(err) {
            if (err) { reject(err); } else { resolve({ id, status, error, changes: this.changes }); }
        });
    });
};

// --- Fungsi-fungsi CRUD Incoming Messages ---

/**
 * Menyimpan pesan masuk ke database.
 * @param {Object} messageData - Objek data pesan masuk.
 * @returns {Promise<Object>}
 */
const saveIncomingMessage = (messageData) => {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error('Database not yet ready.'));
        const { id, deviceName, fromNumber, toNumber, type, body, timestamp, isGroup, senderName, chatId, status } = messageData;
        db.run(`INSERT INTO incoming_messages (id, deviceName, fromNumber, toNumber, type, body, timestamp, isGroup, senderName, chatId, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, deviceName, fromNumber, toNumber, type, body, timestamp, isGroup, senderName, chatId, status], function(err) {
            if (err) { reject(err); } else { resolve({ ...messageData, dbId: this.lastID }); }
        });
    });
};

/**
 * Mengambil pesan masuk dengan opsi filter, limit, dan offset.
 * @param {Object} [options] - Opsi-opsi filter.
 * @param {string} [options.status] - Status pesan yang ingin difilter (bisa koma-separated).
 * @param {string} [options.limit] - Jumlah data yang akan diambil.
 * @param {number} [options.offset=0] - Offset untuk pagination.
 * @returns {Promise<Array<Object>>}
 */
const getIncomingMessages = ({ status, limit, offset = 0 } = {}) => {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error('Database not yet ready.'));
        
        let sql = `SELECT * FROM incoming_messages`;
        const params = [];
        const whereClauses = [];

        if (status) {
            const statusArray = status.split(',');
            if (statusArray.length > 1) {
                const placeholders = statusArray.map(() => '?').join(',');
                whereClauses.push(`status IN (${placeholders})`);
                params.push(...statusArray);
            } else {
                whereClauses.push(`status = ?`);
                params.push(status);
            }
        }
        
        if (whereClauses.length > 0) {
            sql += ` WHERE ` + whereClauses.join(' AND ');
        }

        sql += ` ORDER BY receivedAt DESC`;

        if (limit) {
            sql += ` LIMIT ? OFFSET ?`;
            params.push(limit, offset);
        }

        db.all(sql, params, (err, rows) => {
            if (err) { reject(err); } else { resolve(rows); }
        });
    });
};


// --- Fungsi-fungsi CRUD Templates ---

/**
 * Mengambil semua template.
 * @returns {Promise<Array<Object>>}
 */
const getTemplates = () => {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error('Database not yet ready.'));
        db.all("SELECT * FROM templates", [], (err, rows) => {
            if (err) { reject(err); } else { resolve(rows); }
        });
    });
};

/**
 * Mengambil template berdasarkan nama.
 * @param {string} name - Nama template.
 * @returns {Promise<Object>}
 */
const getTemplateByName = (name) => {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error('Database not yet ready.'));
        db.get("SELECT * FROM templates WHERE name = ?", [name], (err, row) => {
            if (err) { reject(err); } else { resolve(row); }
        });
    });
};

/**
 * Menambahkan template baru.
 * @param {string} name - Nama template.
 * @param {string} content - Konten template.
 * @returns {Promise<Object>}
 */
const addTemplate = (name, content) => {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error('Database not yet ready.'));
        db.run(`INSERT INTO templates (name, content) VALUES (?, ?)`, [name, content], function(err) {
            if (err) { reject(err); } else { resolve({ id: this.lastID, name, content }); }
        });
    });
};

/**
 * Menghapus template berdasarkan nama.
 * @param {string} name - Nama template.
 * @returns {Promise<Object>}
 */
const deleteTemplate = (name) => {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error('Database not yet ready.'));
        db.run(`DELETE FROM templates WHERE name = ?`, [name], function(err) {
            if (err) { reject(err); } else { resolve({ name, changes: this.changes }); }
        });
    });
};


// <<< START: FUNGSI BARU UNTUK DASHBOARD >>>

/**
 * Mengambil ringkasan statistik pesan keluar dari database.
 * @returns {Promise<Object>}
 */
const getMessageSummary = () => {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error('Database not yet ready.'));
        const sql = `
            SELECT 
                COUNT(*) AS total,
                SUM(CASE WHEN status = 'sent' OR status = 'delivered' OR status = 'played' THEN 1 ELSE 0 END) AS sent,
                SUM(CASE WHEN status = 'failed' OR status = 'revoked' THEN 1 ELSE 0 END) AS failed,
                SUM(CASE WHEN status = 'pending' OR status = 'pending' THEN 1 ELSE 0 END) AS pending
            FROM outgoing_messages;
        `;
        db.get(sql, [], (err, row) => {
            if (err) {
                console.error("Error fetching message summary:", err);
                return reject(err);
            }
            resolve({
                total: row.total || 0,
                sent: row.sent || 0,
                failed: row.failed || 0,
                pending: row.pending || 0,
            });
        });
    });
};


/**
 * Mengambil pesan keluar terbaru untuk aktivitas dashboard.
 * @param {number} limit - Jumlah pesan yang ingin diambil.
 * @returns {Promise<Array<Object>>}
 */
const getRecentMessages = (limit) => {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error('Database not yet ready.'));
        const sql = `
            SELECT 
                deviceName,
                toNumber, 
                message,
                status, 
                timestamp
            FROM outgoing_messages
            ORDER BY timestamp DESC
            LIMIT ?;
        `;
        db.all(sql, [limit], (err, rows) => {
            if (err) {
                console.error("Error fetching recent messages:", err);
                return reject(err);
            }
            resolve(rows);
        });
    });
};

// <<< END: FUNGSI BARU UNTUK DASHBOARD >>>

// Ekspor semua fungsi
module.exports = {
    getDbInstance,
    getDevices,
    getDeviceByName,
    addOrUpdateDevice,
    updateDeviceStatus,
    removeDevice,
    saveOutgoingMessage,
    getOutgoingMessages,
    getOutgoingMessageById,
    updateOutgoingMessageStatus,
    saveIncomingMessage,
    getIncomingMessages,
    getTemplates,
    getTemplateByName,
    addTemplate,
    deleteTemplate,
    getMessageSummary,
    getRecentMessages
};

