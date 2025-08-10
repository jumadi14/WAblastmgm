// src/app.js - Kode yang telah digabungkan dari semua file

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    cors: {
        origin: "http://localhost:5173",
        methods: ["GET", "POST", "PUT", "DELETE"]
    }
});

// --- Variabel dan setup dari db.js ---
const DB_FILENAME = 'messages.db';
const DB_PATH = path.join(process.cwd(), 'database', DB_FILENAME);
let db = null;
let dbReadyPromise = null;

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
                    )
                    `, `
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
                    )
                    `, `
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
                    )
                    `, `
                    CREATE TABLE IF NOT EXISTS templates (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        name TEXT UNIQUE NOT NULL,
                        content TEXT NOT NULL,
                        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
                    )
                    `
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

const getDbInstance = () => {
    return dbReadyPromise;
};
const getDevices = () => {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error('Database not yet ready.'));
        db.all("SELECT * FROM devices", [], (err, rows) => {
            if (err) { reject(err); } else { resolve(rows); }
        });
    });
};
const getDeviceByName = (name) => {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error('Database not yet ready.'));
        db.get("SELECT * FROM devices WHERE name = ?", [name], (err, row) => {
            if (err) { reject(err); } else { resolve(row); }
        });
    });
};
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
const removeDevice = (deviceName) => {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error('Database not yet ready.'));
        db.run(`DELETE FROM devices WHERE name = ?`, [deviceName], function(err) {
            if (err) { reject(err); } else { resolve({ deleted: this.changes }); }
        });
    });
};
const getOutgoingMessages = ({ status, limit = 10, offset = 0 } = {}) => {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error('Database not yet ready.'));
        let sql = `SELECT * FROM outgoing_messages`;
        const params = [];
        if (status) {
            sql += ` WHERE status = ?`;
            params.push(status);
        }
        sql += ` ORDER BY timestamp ASC LIMIT ? OFFSET ?`;
        params.push(limit, offset);
        db.all(sql, params, (err, rows) => {
            if (err) { reject(err); } else { resolve(rows); }
        });
    });
};
const getOutgoingMessageById = (id) => {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error('Database not yet ready.'));
        db.get(`SELECT * FROM outgoing_messages WHERE id = ?`, [id], (err, row) => {
            if (err) { reject(err); } else { resolve(row); }
        });
    });
};
const saveOutgoingMessage = (messageData) => {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error('Database not yet ready.'));
        const { id, deviceName, toNumber, message, mediaPath, status = 'pending', timestamp } = messageData;
        db.run(`INSERT INTO outgoing_messages (id, deviceName, toNumber, message, mediaPath, status, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)`, [id, deviceName, toNumber, message, mediaPath, status, timestamp], function(err) {
            if (err) { reject(err); } else { resolve({ ...messageData, dbId: this.lastID }); }
        });
    });
};
const updateOutgoingMessageStatus = (id, status, error = null) => {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error('Database not yet ready.'));
        db.run(`UPDATE outgoing_messages SET status = ?, error = ?, sentAt = CURRENT_TIMESTAMP WHERE id = ?`, [status, error, id], function(err) {
            if (err) { reject(err); } else { resolve({ id, status, error, changes: this.changes }); }
        });
    });
};
const getTemplates = () => {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error('Database not yet ready.'));
        db.all("SELECT * FROM templates", [], (err, rows) => {
            if (err) { reject(err); } else { resolve(rows); }
        });
    });
};
const getTemplateByName = (name) => {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error('Database not yet ready.'));
        db.get("SELECT * FROM templates WHERE name = ?", [name], (err, row) => {
            if (err) { reject(err); } else { resolve(row); }
        });
    });
};
const addTemplate = (name, content) => {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error('Database not yet ready.'));
        db.run(`INSERT INTO templates (name, content) VALUES (?, ?)`, [name, content], function(err) {
            if (err) { reject(err); } else { resolve({ id: this.lastID, name, content }); }
        });
    });
};
const deleteTemplate = (name) => {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error('Database not yet ready.'));
        db.run(`DELETE FROM templates WHERE name = ?`, [name], function(err) {
            if (err) { reject(err); } else { resolve({ name, changes: this.changes }); }
        });
    });
};
const saveIncomingMessage = (messageData) => {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error('Database not yet ready.'));
        const { id, deviceName, fromNumber, toNumber, type, body, timestamp, isGroup, senderName, chatId, status } = messageData;
        db.run(`INSERT INTO incoming_messages (id, deviceName, fromNumber, toNumber, type, body, timestamp, isGroup, senderName, chatId, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, deviceName, fromNumber, toNumber, type, body, timestamp, isGroup, senderName, chatId, status], function(err) {
            if (err) { reject(err); } else { resolve({ ...messageData, dbId: this.lastID }); }
        });
    });
};

// --- Variabel dan fungsi dari whatsappService.js ---
const clients = {};
const getSessionPath = (deviceName) => {
    return path.join(process.cwd(), 'sessions', deviceName);
};
const formatPhoneNumber = (number) => {
    if (!number || typeof number !== 'string') {
        throw new Error('Invalid phone number: must be a string');
    }
    let formatted = number.replace(/\D/g, '');
    if (formatted.startsWith('0')) {
        formatted = '62' + formatted.substring(1);
    } else if (!formatted.startsWith('62')) {
        formatted = '62' + formatted;
    }
    return `${formatted}@c.us`;
};
const validateNumber = async(deviceName, number) => {
    console.log(`[WWS] Memvalidasi nomor ${number} menggunakan klien ${deviceName}...`);
    if (!deviceName || typeof deviceName !== 'string') {
        console.error(`[WWS] Nama perangkat tidak valid: ${deviceName}`);
        throw new Error('Invalid device name: must be a non-empty string');
    }
    if (!number || typeof number !== 'string') {
        console.error(`[WWS] Nomor tidak valid: ${number}`);
        throw new Error('Invalid phone number: must be a non-empty string');
    }
    const clientData = clients[deviceName];
    if (!clientData || !clientData.client) {
        console.error(`[WWS] Klien ${deviceName} tidak ditemukan.`);
        console.error(`[WWS] Klien yang tersedia:`, Object.keys(clients));
        throw new Error(`WhatsApp client ${deviceName} not found`);
    }
    if (clientData.status !== 'connected') {
        console.error(`[WWS] Klien ${deviceName} tidak terhubung. Status: ${clientData.status}`);
        throw new Error(`WhatsApp client ${deviceName} is not connected. Current status: ${clientData.status}`);
    }
    try {
        const formattedNumber = formatPhoneNumber(number);
        console.log(`[WWS] Nomor diformat: ${number} -> ${formattedNumber}`);
        const isRegistered = await clientData.client.isRegisteredUser(formattedNumber);
        console.log(`[WWS] Validasi selesai untuk ${number}. Terdaftar: ${isRegistered}`);
        return isRegistered;
    } catch (error) {
        console.error(`[WWS] Error saat memvalidasi nomor ${number}:`, error);
        throw new Error(`Failed to validate number with client ${deviceName}: ${error.message}`);
    }
};
const startWhatsappClient = async(deviceName) => {
    console.log(`[WWS] Memulai inisialisasi klien WhatsApp untuk: ${deviceName}`);
    if (clients[deviceName] && clients[deviceName].client && (await clients[deviceName].client.getState()) === 'CONNECTED') {
        console.log(`[WWS] Klien ${deviceName} sudah terhubung.`);
        return { success: true, message: `Client ${deviceName} is already connected.`, status: 'connected' };
    }
    if (clients[deviceName] && clients[deviceName].initializing) {
        console.log(`[WWS] Klien ${deviceName} sudah dalam proses inisialisasi.`);
        return { success: false, message: `Client ${deviceName} is already initializing.`, status: 'initializing' };
    }
    clients[deviceName] = {
        client: null,
        initializing: true,
        qrCode: null,
        status: 'initializing',
        phoneNumber: null
    };
    try {
        console.log(`[WWS] Mengupdate status database untuk ${deviceName} menjadi 'initializing'.`);
        await updateDeviceStatus(deviceName, 'initializing');
        console.log(`[WWS] Membuat instance Client whatsapp-web.js untuk ${deviceName}.`);
        const client = new Client({
            authStrategy: new LocalAuth({
                clientId: deviceName,
                dataPath: getSessionPath(deviceName)
            }),
            puppeteer: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--single-process',
                    '--disable-gpu'
                ],
            }
        });
        clients[deviceName].client = client;
        client.on('qr', async(qr) => {
            console.log(`[WWS] Event 'qr' DITERIMA untuk ${deviceName}`);
            clients[deviceName].qrCode = qr;
            clients[deviceName].status = 'qr_code';
            await updateDeviceStatus(deviceName, 'qr_code', null, qr);
            if (io) {
                const qrDataUrl = await qrcode.toDataURL(qr);
                io.emit('device_status_update', { deviceName, status: 'qr_code', qrCode: qrDataUrl });
            }
            qrcodeTerminal.generate(qr, { small: true });
        });
        client.on('ready', async() => {
            console.log(`[WWS] Event 'ready' DITERIMA untuk ${deviceName}!`);
            clients[deviceName].initializing = false;
            clients[deviceName].qrCode = null;
            clients[deviceName].status = 'connected';
            const number = client.info.wid.user;
            clients[deviceName].phoneNumber = number;
            await updateDeviceStatus(deviceName, 'connected', number, null);
            if (io) {
                io.emit('device_status_update', { deviceName, status: 'connected', phoneNumber: number });
            }
        });
        client.on('authenticated', async(session) => {
            console.log(`[WWS] Event 'authenticated' DITERIMA untuk ${deviceName}`);
            clients[deviceName].status = 'authenticated';
            await updateDeviceStatus(deviceName, 'authenticated');
            if (io) {
                io.emit('device_status_update', { deviceName, status: 'authenticated' });
            }
        });
        client.on('auth_failure', async(msg) => {
            console.error(`[WWS] Event 'auth_failure' DITERIMA untuk ${deviceName}:`, msg);
            clients[deviceName].initializing = false;
            clients[deviceName].status = 'disconnected';
            clients[deviceName].qrCode = null;
            clients[deviceName].phoneNumber = null;
            await updateDeviceStatus(deviceName, 'disconnected', null, null, `Auth Failure: ${msg}`);
            if (io) {
                io.emit('device_status_update', { deviceName, status: 'auth_failure', error: msg });
            }
            const sessionPath = getSessionPath(deviceName);
            if (fs.existsSync(sessionPath)) {
                await fs.remove(sessionPath);
                console.log(`[WWS] Menghapus data sesi untuk ${deviceName} karena kegagalan otentikasi.`);
            }
            if (clients[deviceName]) {
                clients[deviceName].client = null;
            }
        });
        client.on('disconnected', async(reason) => {
            console.log(`[WWS] Event 'disconnected' DITERIMA untuk ${deviceName}. Alasan: ${reason}`);
            clients[deviceName].initializing = false;
            clients[deviceName].status = 'disconnected';
            clients[deviceName].qrCode = null;
            clients[deviceName].phoneNumber = null;
            await updateDeviceStatus(deviceName, 'disconnected', null, null, `Disconnected: ${reason}`);
            if (io) {
                io.emit('device_status_update', { deviceName, status: 'disconnected', reason: reason });
            }
            if (clients[deviceName]) {
                clients[deviceName].client = null;
            }
        });
        client.on('message', async(msg) => {
            console.log(`[WWS] Event 'message' DITERIMA:`, msg.body);
            const messageData = {
                id: msg.id.id,
                deviceName: deviceName,
                from: msg.from,
                to: msg.to,
                type: msg.type,
                body: msg.body,
                timestamp: new Date(msg.timestamp * 1000).toISOString(),
                isGroup: msg.isGroupMsg,
                senderName: msg.fromMe ? 'Me' : (await msg.getContact()).name || msg.from,
                chatId: msg.from,
                status: 'unread'
            };
            await saveIncomingMessage(messageData);
            if (io) {
                io.emit('new_incoming_message', messageData);
            }
        });
        client.on('message_ack', async(msg, ack) => {
            const messageId = msg.id.id;
            let status;
            switch (ack) {
                case 1:
                    status = 'sent';
                    break;
                case 2:
                    status = 'delivered';
                    break;
                case 3:
                    status = 'read';
                    break;
                case 4:
                    status = 'played';
                    break;
                case -1:
                    status = 'failed';
                    break;
                default:
                    status = 'unknown';
                    break;
            }
            console.log(`[WWS] Event 'message_ack' DITERIMA untuk ${messageId} (status: ${status})`);
            await updateOutgoingMessageStatus(messageId, status);
            if (io) {
                io.emit('outgoing_message_status_update', { messageId, status });
            }
        });
        console.log(`[WWS] Memanggil client.initialize() untuk ${deviceName}...`);
        await client.initialize();
        console.log(`[WWS] client.initialize() untuk ${deviceName} telah selesai.`);
        return { success: true, message: `Client ${deviceName} initialized.`, status: clients[deviceName].status };
    } catch (error) {
        console.error(`[WWS] Error saat inisialisasi klien ${deviceName}:`, error);
        if (clients[deviceName]) {
            clients[deviceName].initializing = false;
            clients[deviceName].status = 'error';
            clients[deviceName].qrCode = null;
            clients[deviceName].phoneNumber = null;
            await updateDeviceStatus(deviceName, 'error', null, null, error.message);
            if (io) {
                io.emit('device_status_update', { deviceName, status: 'error', error: error.message });
            }
        }
        return { success: false, message: `Error initializing client ${deviceName}: ${error.message}`, status: 'error' };
    }
};
const sendMessage = async(deviceName, to, message, mediaPath = null, messageId = null) => {
    console.log(`[WWS] Mencoba mengirim pesan ke ${to} via ${deviceName}. Media: ${mediaPath ? 'Yes' : 'No'}. Message ID: ${messageId || 'N/A'}`);
    const clientData = clients[deviceName];
    if (!clientData || !clientData.client) {
        console.error(`[WWS] Klien ${deviceName} tidak ditemukan atau belum diinisialisasi`);
        console.error(`[WWS] Klien yang tersedia:`, Object.keys(clients));
        return { success: false, error: `Client ${deviceName} not found or not initialized` };
    }
    let clientState;
    try {
        clientState = await clientData.client.getState();
    } catch (error) {
        console.error(`[WWS] Gagal mendapatkan status klien ${deviceName}:`, error);
        return { success: false, error: `Failed to get client state: ${error.message}` };
    }
    const validStates = ['CONNECTED', 'OPENING', 'SYNCING', 'PAIRING'];
    if (!validStates.includes(clientState)) {
        console.error(`[WWS] Klien ${deviceName} tidak dalam status valid. Status saat ini: ${clientState}`);
        return { success: false, error: `Client ${deviceName} is not in a valid state. Current state: ${clientState}` };
    }
    if (!message && !mediaPath) {
        console.error(`[WWS] Pesan atau mediaPath harus disediakan untuk pengiriman.`);
        return { success: false, error: 'Message content or media file is required.' };
    }
    const client = clientData.client;
    const targetNumber = formatPhoneNumber(to);
    console.log(`[WWS] Nomor tujuan diformat: ${to} -> ${targetNumber}`);
    try {
        let sentMsg;
        const sendStartTime = Date.now();
        if (mediaPath) {
            if (!fs.existsSync(mediaPath)) {
                console.error(`[WWS] File media tidak ditemukan: ${mediaPath}`);
                return { success: false, error: 'Media file not found' };
            }
            const media = MessageMedia.fromFilePath(mediaPath);
            console.log(`[WWS] Mengirim pesan media ke ${targetNumber}`);
            const sendPromise = client.sendMessage(targetNumber, media, { caption: message });
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Send timeout after 30 seconds')), 30000)
            );
            sentMsg = await Promise.race([sendPromise, timeoutPromise]);
        } else {
            console.log(`[WWS] Mengirim pesan teks ke ${targetNumber}`);
            const sendPromise = client.sendMessage(targetNumber, message);
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Send timeout after 30 seconds')), 30000)
            );
            sentMsg = await Promise.race([sendPromise, timeoutPromise]);
        }
        const sendDuration = Date.now() - sendStartTime;
        console.log(`[WWS] Pesan terkirim dari ${deviceName} ke ${targetNumber} dalam ${sendDuration}ms. WhatsApp Message ID: ${sentMsg.id.id}`);
        return {
            success: true,
            whatsappMessageId: sentMsg.id.id,
            response: sentMsg,
            sendDuration: sendDuration
        };
    } catch (error) {
        console.error(`[WWS] Error mengirim pesan dari ${deviceName} ke ${targetNumber}:`, error);
        console.error(`[WWS] Detail error:`, {
            deviceName,
            originalNumber: to,
            formattedNumber: targetNumber,
            clientState,
            messageLength: message ? message.length : 0,
            hasMedia: !!mediaPath,
            errorStack: error.stack
        });
        return {
            success: false,
            error: error.message,
            errorDetails: {
                originalNumber: to,
                formattedNumber: targetNumber,
                clientState
            }
        };
    }
};
const logoutWhatsappClient = async(deviceName) => {
    console.log(`[WWS] Mencoba logout klien: ${deviceName}`);
    const clientData = clients[deviceName];
    if (clientData && clientData.client) {
        try {
            await clientData.client.logout();
            console.log(`[WWS] Klien ${deviceName} berhasil logout.`);
            const sessionPath = getSessionPath(deviceName);
            if (fs.existsSync(sessionPath)) {
                await fs.remove(sessionPath);
                console.log(`[WWS] Menghapus data sesi untuk ${deviceName}.`);
            }
            delete clients[deviceName];
            await removeDevice(deviceName);
            if (io) {
                io.emit('device_status_update', { deviceName, status: 'removed' });
            }
            return { success: true, message: `Client ${deviceName} logged out and removed.` };
        } catch (error) {
            console.error(`[WWS] Error saat logout klien ${deviceName}:`, error);
            await updateDeviceStatus(deviceName, 'disconnected', null, null, `Logout failed: ${error.message}`);
            if (io) {
                io.emit('device_status_update', { deviceName, status: 'disconnected', error: `Logout failed: ${error.message}` });
            }
            throw new Error(`Failed to logout client: ${error.message}`);
        }
    } else {
        console.log(`[WWS] Klien ${deviceName} tidak ditemukan atau tidak diinisialisasi untuk logout. Mencoba pembersihan.`);
        const sessionPath = getSessionPath(deviceName);
        if (fs.existsSync(sessionPath)) {
            await fs.remove(sessionPath);
            console.log(`[WWS] Menghapus data sesi untuk ${deviceName}.`);
        }
        await removeDevice(deviceName);
        if (io) {
            io.emit('device_status_update', { deviceName, status: 'removed' });
        }
        return { success: true, message: `Client ${deviceName} not found in memory, but attempted to remove from DB and disk.` };
    }
};
const getAllClientStatuses = async() => {
    console.log('[WWS] Mengambil semua status klien...');
    const devices = await getDevices();
    const statuses = devices.map(device => {
        let currentStatus = device.status;
        let qrCodeData = device.qrCode || null;
        let phoneNumber = device.phoneNumber || null;
        if (clients[device.name]) {
            if (clients[device.name].client && clients[device.name].client.state === 'CONNECTED') {
                currentStatus = 'connected';
                phoneNumber = clients[device.name].phoneNumber || phoneNumber;
                qrCodeData = null;
            } else if (clients[device.name].status === 'qr_code') {
                currentStatus = 'qr_code';
                qrCodeData = clients[device.name].qrCode ? `data:image/png;base64,${clients[device.name].qrCode}` : null;
            } else if (clients[device.name].status === 'initializing') {
                currentStatus = 'initializing';
            } else if (clients[device.name].status === 'authenticated') {
                currentStatus = 'authenticated';
            } else {
                currentStatus = clients[device.name].status;
            }
        } else {
            if (device.status === 'connected' || device.status === 'authenticated') {
                currentStatus = 'disconnected';
                phoneNumber = null;
            } else {
                currentStatus = device.status;
            }
        }
        return {
            deviceName: device.name,
            status: currentStatus,
            qrCodeData: qrCodeData,
            phoneNumber: phoneNumber
        };
    });
    console.log('[WWS] Selesai mengambil status klien.');
    return statuses;
};
const getClientStatus = (deviceName) => {
    const clientData = clients[deviceName];
    return clientData ? clientData.status : 'disconnected';
};
const initializeExistingClients = async() => {
    console.log('[WWS] Mencoba menginisialisasi ulang klien WhatsApp yang sudah ada dari DB...');
    const devices = await getDevices();
    for (const device of devices) {
        if (device.status === 'connected' || device.status === 'authenticated') {
            const sessionPath = getSessionPath(device.name);
            if (await fs.pathExists(sessionPath)) {
                console.log(`[WWS] Session ditemukan untuk ${device.name}, mencoba inisialisasi...`);
                try {
                    await startWhatsappClient(device.name);
                } catch (error) {
                    console.error(`[WWS] Error selama inisialisasi ulang ${device.name}:`, error);
                    await updateDeviceStatus(device.name, 'disconnected', null, null, `Initialization failed: ${error.message}`);
                }
            } else {
                console.log(`[WWS] Session tidak ditemukan untuk ${device.name}, melewati inisialisasi`);
                await updateDeviceStatus(device.name, 'disconnected', null, null, 'Session not found');
            }
        }
    }
    console.log('[WWS] Selesai mencoba menginisialisasi ulang klien yang sudah ada.');
};

// --- Variabel dan fungsi dari messageScheduler.js ---
const blastQueue = [];
let isProcessingQueue = false;

const sendStatusUpdate = (status, message) => {
    if (io) {
        io.emit('blastStatus', { status, message });
    }
};
const processQueue = async() => {
    if (isProcessingQueue) return console.log(`[Scheduler] Queue skipped. Already processing.`);
    if (blastQueue.length === 0) return console.log(`[Scheduler] Antrean kosong. Tidak ada yang diproses.`);
    isProcessingQueue = true;
    console.log('[Scheduler] Memulai pemrosesan antrean blast...');
    try {
        while (blastQueue.length > 0) {
            const blast = blastQueue[0];
            const { messageIds, intervalSeconds, deviceName, scheduledTime } = blast;
            if (new Date(scheduledTime).getTime() > Date.now()) {
                console.log(`[Scheduler] Blast untuk ${deviceName} masih dijadwalkan di masa depan. Menunggu.`);
                isProcessingQueue = false;
                setTimeout(processQueue, new Date(scheduledTime).getTime() - Date.now());
                return;
            }
            console.log(`[Scheduler] Memproses blast untuk ${deviceName} dengan ${messageIds.length} pesan`);
            let clientStatus = getClientStatus(deviceName);
            console.log(`[Scheduler] Status klien ${deviceName}: ${clientStatus}`);
            const validStatuses = ['connected', 'authenticated'];
            if (!validStatuses.includes(clientStatus)) {
                console.error(`[Scheduler] ❌ Perangkat ${deviceName} tidak terhubung. Mencoba memulai ulang...`);
                sendStatusUpdate('failed', `Perangkat ${deviceName} tidak terhubung. Mencoba memulai ulang...`);
                try {
                    const startResult = await startWhatsappClient(deviceName);
                    if (startResult.success && validStatuses.includes(startResult.status)) {
                        console.log(`[Scheduler] ✅ Klien ${deviceName} berhasil dimulai ulang.`);
                        sendStatusUpdate('info', `Perangkat ${deviceName} berhasil terhubung kembali.`);
                    } else {
                        throw new Error(`Gagal memulai ulang: ${startResult.message}`);
                    }
                } catch (err) {
                    console.error(`[Scheduler] ❌ Gagal memulai ulang klien ${deviceName}: ${err.message}`);
                    sendStatusUpdate('failed', `Gagal memulai ulang perangkat ${deviceName}.`);
                    for (const messageId of messageIds) {
                        await updateOutgoingMessageStatus(messageId, 'failed', `Device not connected and restart failed`);
                    }
                    blastQueue.shift();
                    continue;
                }
            }
            console.log(`[Scheduler] ✅ Perangkat ${deviceName} terhubung, memulai pengiriman...`);
            for (let i = 0; i < messageIds.length; i++) {
                const messageId = messageIds[i];
                console.log(`[Scheduler] Memproses pesan ID: ${messageId}`);
                sendStatusUpdate('info', `Mengirim pesan ${i + 1} dari ${messageIds.length} untuk perangkat ${deviceName}...`);
                const messageData = await getOutgoingMessageById(messageId);
                if (!messageData) {
                    console.warn(`[Scheduler] Pesan dengan ID ${messageId} tidak ditemukan di database. Melewati.`);
                    continue;
                }
                if (messageData.status !== 'pending') {
                    console.warn(`[Scheduler] Pesan dengan ID ${messageId} sudah memiliki status '${messageData.status}'. Melewati.`);
                    continue;
                }
                const { toNumber, message, mediaPath } = messageData;
                await updateOutgoingMessageStatus(messageId, 'sending');
                const sendResult = await sendMessage(deviceName, toNumber, message, mediaPath, messageId);
                if (sendResult.success) {
                    console.log(`[Scheduler] ✅ Pesan ID ${messageId} berhasil dikirim. WhatsApp ID: ${sendResult.whatsappMessageId}`);
                    // Status akan diperbarui oleh event message_ack
                } else {
                    console.error(`[Scheduler] ❌ Gagal mengirim pesan ID ${messageId}: ${sendResult.error}`);
                    await updateOutgoingMessageStatus(messageId, 'failed', sendResult.error);
                }
                if (i < messageIds.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, intervalSeconds * 1000));
                }
            }
            blastQueue.shift();
        }
    } catch (error) {
        console.error(`[Scheduler] Terjadi error fatal saat memproses antrean:`, error);
        sendStatusUpdate('error', `Terjadi error saat memproses antrean: ${error.message}`);
    } finally {
        isProcessingQueue = false;
        console.log('[Scheduler] Selesai memproses antrean.');
        sendStatusUpdate('completed', 'Semua pesan telah diproses.');
    }
};
const addToQueue = (blastJob) => {
    blastQueue.push(blastJob);
    console.log(`[Scheduler] Menambahkan blast baru ke antrean. Total item: ${blastQueue.length}`);
    processQueue();
};
const getBlastQueue = () => {
    return blastQueue;
};
const getIsProcessingQueue = () => {
    return isProcessingQueue;
};

// --- Setup Multer untuk upload file ---
const uploadDir = path.join(process.cwd(), 'uploads');
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        fs.ensureDir(uploadDir).then(() => {
            cb(null, uploadDir);
        }).catch(err => {
            console.error('Error ensuring upload directory exists:', err);
            cb(err);
        });
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

// --- Middleware Express ---
app.use(cors({
    origin: "http://localhost:5173"
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(uploadDir));

// --- Rute dari whatsappRoutes.js ---
const whatsappRoutes = (upload) => {
    const router = express.Router();
    router.get('/devices', async(req, res) => {
        try {
            const statuses = await getAllClientStatuses();
            res.json(statuses);
        } catch (error) {
            console.error('[Backend Error] Error fetching device statuses:', error.message);
            res.status(500).json({ error: 'Failed to fetch device statuses', details: error.message });
        }
    });
    router.post('/validate-number', async(req, res) => {
        const { deviceName, number, numbers } = req.body;
        if (!deviceName) {
            return res.status(400).json({ error: 'Device name is required.' });
        }
        let numbersToValidate = [];
        if (number && typeof number === 'string') {
            numbersToValidate = [number];
        } else if (numbers && Array.isArray(numbers) && numbers.length > 0) {
            numbersToValidate = numbers;
        } else {
            return res.status(400).json({ error: 'A valid number or array of numbers is required.' });
        }
        const validationResults = [];
        for (const num of numbersToValidate) {
            try {
                const isValid = await validateNumber(deviceName, num);
                validationResults.push({ number: num, isValid });
            } catch (error) {
                console.error('[Backend Error] Error validating number:', error.message);
                validationResults.push({ number: num, isValid: false, error: error.message });
            }
        }
        res.status(200).json({ validationResults });
    });
    router.post('/start', async(req, res) => {
        const { deviceName } = req.body;
        if (!deviceName) {
            return res.status(400).json({ error: 'Device name is required.' });
        }
        try {
            console.log(`[Backend Log] Menerima permintaan /whatsapp/start untuk: ${deviceName}`);
            const result = await startWhatsappClient(deviceName);
            res.status(200).json(result);
        } catch (error) {
            console.error(`[Backend Error] Gagal memulai klien ${deviceName}:`, error);
            res.status(500).json({ error: `Failed to start client: ${error.message}` });
        }
    });
    router.post('/send-message', upload.single('media'), async(req, res) => {
        const { deviceName, to, message } = req.body;
        const mediaPath = req.file ? req.file.path : null;
        if (!deviceName || !to || (!message && !mediaPath)) {
            return res.status(400).json({ error: 'Device name, recipient, and message/media are required.' });
        }
        try {
            const sendResult = await sendMessage(deviceName, to, message, mediaPath);
            if (sendResult.success) {
                res.status(200).json({ message: 'Message sent successfully', whatsappMessageId: sendResult.whatsappMessageId, sendDuration: sendResult.sendDuration });
            } else {
                res.status(500).json({ error: sendResult.error });
            }
        } catch (error) {
            console.error('[Backend Error] Error sending message:', error);
            res.status(500).json({ error: 'Failed to send message', details: error.message });
        }
    });
    router.post('/logout', async(req, res) => {
        const { deviceName } = req.body;
        if (!deviceName) {
            return res.status(400).json({ error: 'Device name is required.' });
        }
        try {
            const result = await logoutWhatsappClient(deviceName);
            res.status(200).json(result);
        } catch (error) {
            console.error('[Backend Error] Error logging out:', error);
            res.status(500).json({ error: `Failed to logout: ${error.message}` });
        }
    });
    router.get('/templates', async(req, res) => {
        try {
            const templates = await getTemplates();
            res.json(templates);
        } catch (error) {
            console.error('[Backend Error] Error fetching templates:', error.message);
            res.status(500).json({ error: 'Failed to fetch templates', details: error.message });
        }
    });
    router.post('/templates', async(req, res) => {
        const { name, content } = req.body;
        if (!name || !content) {
            return res.status(400).json({ error: 'Template name and content are required.' });
        }
        try {
            await getDbInstance();
            const result = await addTemplate(name, content);
            res.status(201).json({ message: 'Template added successfully', template: result });
        } catch (error) {
            console.error('[Backend Error] Error adding template:', error.message);
            res.status(500).json({ error: 'Failed to add template', details: error.message });
        }
    });
    router.delete('/templates/:name', async(req, res) => {
        const { name } = req.params;
        try {
            await getDbInstance();
            const result = await deleteTemplate(name);
            if (result.changes > 0) {
                res.status(200).json({ message: 'Template deleted successfully', name: name });
            } else {
                res.status(404).json({ error: 'Template not found' });
            }
        } catch (error) {
            console.error('[Backend Error] Error deleting template:', error.message);
            res.status(500).json({ error: 'Failed to delete template', details: error.message });
        }
    });
    return router;
};

// --- Rute API untuk Upload Gambar ---
app.post('/api/images/upload', upload.single('image'), async(req, res) => {
    try {
        await getDbInstance();
        if (!req.file) {
            console.log('[API] Upload Image: No file uploaded.');
            return res.status(400).json({ error: 'No image file uploaded.' });
        }
        const imageId = path.basename(req.file.path);
        console.log(`[API] Upload Image: Gambar diunggah: ${imageId}`);
        res.json({ message: 'Image uploaded successfully', imageId: imageId });
    } catch (error) {
        console.error('[API] Upload Image: Error uploading image:', error);
        res.status(500).json({ error: 'Failed to upload image.', details: error.message });
    }
});

// --- Rute API untuk Debugging ---
app.get('/api/debug/scheduler', (req, res) => {
    try {
        const isProcessing = getIsProcessingQueue();
        const queue = getBlastQueue();
        res.json({
            isProcessingQueue: isProcessing,
            queueLength: queue.length,
            queueItems: queue.map(item => ({
                deviceName: item.deviceName,
                messageCount: item.messageIds.length,
                intervalSeconds: item.intervalSeconds
            }))
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
app.get('/api/debug/messages', async(req, res) => {
    try {
        await getDbInstance();
        const pendingMessages = await getOutgoingMessages({ status: 'pending' });
        res.json({
            pendingCount: pendingMessages.length,
            pendingMessages: pendingMessages.slice(0, 5)
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- Rute API untuk Jadwal Blast Excel ---
app.post('/api/blast-excel', async(req, res) => {
    console.log('🚀 BLAST EXCEL REQUEST DITERIMA:', req.body);
    const { contacts, scheduledTime, intervalSeconds, templateName, deviceName, imageId } = req.body;
    if (!contacts || contacts.length === 0 || !scheduledTime || !intervalSeconds || !deviceName) {
        console.error('[API] Blast Excel: Data input tidak lengkap atau tidak valid.');
        return res.status(400).json({ error: 'Missing required fields: contacts, scheduledTime, intervalSeconds, deviceName.' });
    }
    try {
        await getDbInstance();
        let templateContent = '';
        if (templateName) {
            const templates = await getTemplates();
            const foundTemplate = templates.find(t => t.name === templateName);
            if (foundTemplate) {
                templateContent = foundTemplate.content;
                console.log(`[API] Blast Excel: Template '${templateName}' ditemukan.`);
            } else {
                console.warn(`[API] Blast Excel: Template '${templateName}' tidak ditemukan.`);
            }
        }
        let mediaPath = null;
        if (imageId) {
            mediaPath = path.join(process.cwd(), 'uploads', imageId);
            if (!fs.existsSync(mediaPath)) {
                console.warn(`[API] Blast Excel: File gambar tidak ditemukan di path: ${mediaPath}.`);
                mediaPath = null;
            } else {
                console.log(`[API] Blast Excel: File gambar ditemukan di path: ${mediaPath}.`);
            }
        }
        const messageIdsToSchedule = [];
        const now = new Date();
        const scheduledDate = new Date(scheduledTime);
        const effectiveScheduledTime = scheduledDate > now ? scheduledDate.toISOString() : now.toISOString();
        for (const contact of contacts) {
            if (contact.number) {
                const messageId = uuidv4();
                const personalizedMessage = templateContent.replace(/{(\w+)}/g, (match, key) => contact[key] || '');
                const messageData = {
                    id: messageId,
                    deviceName,
                    toNumber: contact.number,
                    message: personalizedMessage,
                    mediaPath: mediaPath,
                    status: 'pending',
                    timestamp: effectiveScheduledTime
                };
                await saveOutgoingMessage(messageData);
                messageIdsToSchedule.push(messageId);
            }
        }
        if (messageIdsToSchedule.length > 0) {
            addToQueue({
                deviceName,
                messageIds: messageIdsToSchedule,
                intervalSeconds: parseInt(intervalSeconds, 10),
                scheduledTime: effectiveScheduledTime
            });
            res.status(200).json({
                message: `${messageIdsToSchedule.length} messages scheduled successfully for device '${deviceName}'`,
                scheduledMessages: messageIdsToSchedule.length,
                scheduledTime: effectiveScheduledTime
            });
        } else {
            res.status(400).json({ error: 'No valid contacts with numbers to schedule.' });
        }
    } catch (error) {
        console.error('[API] Blast Excel: Error scheduling messages:', error);
        res.status(500).json({ error: 'Failed to schedule messages.', details: error.message });
    }
});

// --- Daftarkan Rute API WhatsApp ---
app.use('/api/whatsapp', whatsappRoutes(upload));

// --- Inisialisasi dan jalankan aplikasi ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server berjalan di port ${PORT}`);
    // Panggil fungsi inisialisasi setelah server berjalan
    initializeExistingClients();
    
    // Jadwalkan cron job untuk memproses antrean setiap 30 detik
    cron.schedule('*/30 * * * * *', () => {
        console.log(`[Cron] Memeriksa antrean pesan blast...`);
        processQueue();
    });
});
