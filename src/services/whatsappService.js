// src/services/whatsappService.js

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const path = require('path');
const db = require('./db');
const fs = require('fs-extra');

const clients = {};
let io;

const setSocketIo = (socketServer) => {
    console.log("[WWS] Socket.IO server set in whatsappService.");
    io = socketServer;
};

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
        await db.updateDeviceStatus(deviceName, 'initializing');
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
                ],
            }
        });
        clients[deviceName].client = client;
        client.on('qr', async(qr) => {
            console.log(`[WWS] Event 'qr' DITERIMA untuk ${deviceName}`);
            clients[deviceName].qrCode = qr;
            clients[deviceName].status = 'qr_code';
            await db.updateDeviceStatus(deviceName, 'qr_code', null, qr);
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
            await db.updateDeviceStatus(deviceName, 'connected', number, null);
            if (io) {
                io.emit('device_status_update', { deviceName, status: 'connected', phoneNumber: number });
            }
        });
        client.on('authenticated', async(session) => {
            console.log(`[WWS] Event 'authenticated' DITERIMA untuk ${deviceName}`);
            clients[deviceName].status = 'authenticated';
            await db.updateDeviceStatus(deviceName, 'authenticated');
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
            await db.updateDeviceStatus(deviceName, 'disconnected', null, null, `Auth Failure: ${msg}`);
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
            await db.updateDeviceStatus(deviceName, 'disconnected', null, null, `Disconnected: ${reason}`);
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
                fromNumber: msg.from,
                toNumber: msg.to,
                type: msg.type,
                body: msg.body,
                timestamp: new Date(msg.timestamp * 1000).toISOString(),
                isGroup: msg.isGroupMsg,
                senderName: msg.fromMe ? 'Me' : (await msg.getContact()).name || msg.from,
                chatId: msg.from,
                status: 'unread'
            };
            await db.saveIncomingMessage(messageData);
            if (io) {
                io.emit('new_incoming_message', messageData);
            }
        });

        // --- PERBAIKAN: Listener untuk event message_ack diperbarui ---
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
                default:
                    status = 'unknown';
                    break;
            }
            
            // Hanya perbarui pesan yang dikirim oleh kita sendiri
            if (msg.fromMe && status !== 'unknown') {
                console.log(`[WWS] Event 'message_ack' DITERIMA untuk ${messageId} (status: ${status})`);
                await db.updateOutgoingMessageStatus(messageId, status);
                if (io) {
                    io.emit('outgoing_message_status_update', { deviceName, messageId, status });
                }
            }
        });

        // --- PERBAIKAN: Tambahkan listener untuk event message_send_error ---
        client.on('message_send_error', async(err, msg) => {
            console.error(`[WWS] Error mengirim pesan dari ${msg.from} ke ${msg.to}:`, err);
            const messageId = msg.id.id;
            await db.updateOutgoingMessageStatus(messageId, 'failed', err.message);
            if (io) {
                io.emit('outgoing_message_status_update', {
                    deviceName,
                    messageId,
                    status: 'failed',
                    error: err.message
                });
            }
        });
        // --- AKHIR PERBAIKAN ---

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
            await db.updateDeviceStatus(deviceName, 'error', null, null, error.message);
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
            await db.removeDevice(deviceName);
            if (io) {
                io.emit('device_status_update', { deviceName, status: 'removed' });
            }
            return { success: true, message: `Client ${deviceName} logged out and removed.` };
        } catch (error) {
            console.error(`[WWS] Error saat logout klien ${deviceName}:`, error);
            await db.updateDeviceStatus(deviceName, 'disconnected', null, null, `Logout failed: ${error.message}`);
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
        await db.removeDevice(deviceName);
        if (io) {
            io.emit('device_status_update', { deviceName, status: 'removed' });
        }
        return { success: true, message: `Client ${deviceName} not found in memory, but attempted to remove from DB and disk.` };
    }
};

const getAllClientStatuses = async() => {
    console.log('[WWS] Mengambil semua status klien...');
    const devices = await db.getDevices();
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

// PERBAIKAN: Fungsi ini sekarang async dan mengambil status dari DB jika tidak ditemukan di memori
const getClientStatus = async(deviceName) => {
    console.log(`[WWS] Mengambil status untuk ${deviceName}...`);
    // Periksa status dari klien yang sedang berjalan
    const clientData = clients[deviceName];
    if (clientData) {
        console.log(`[WWS] Status ditemukan di memori: ${clientData.status}`);
        return { status: clientData.status };
    }

    // Jika tidak ada di memori, periksa status terakhir di database
    console.log(`[WWS] Status tidak ditemukan di memori, memeriksa database...`);
    const deviceFromDb = await db.getDeviceByName(deviceName);
    if (deviceFromDb) {
        console.log(`[WWS] Status ditemukan di DB: ${deviceFromDb.status}`);
        return { status: deviceFromDb.status };
    }

    // Jika tidak ada di mana pun, anggap terputus
    console.log(`[WWS] Status tidak ditemukan. Mengembalikan 'disconnected'.`);
    return { status: 'disconnected' };
};

const initializeExistingClients = async() => {
    console.log('[WWS] Mencoba menginisialisasi ulang klien WhatsApp yang sudah ada dari DB...');
    const devices = await db.getDevices();
    for (const device of devices) {
        if (device.status === 'connected' || device.status === 'authenticated') {
            const sessionPath = getSessionPath(device.name);
            if (await fs.pathExists(sessionPath)) {
                console.log(`[WWS] Session ditemukan untuk ${device.name}, mencoba inisialisasi...`);
                try {
                    await startWhatsappClient(device.name);
                } catch (error) {
                    console.error(`[WWS] Error selama inisialisasi ulang ${device.name}:`, error);
                    await db.updateDeviceStatus(device.name, 'disconnected', null, null, `Initialization failed: ${error.message}`);
                }
            } else {
                console.log(`[WWS] Session tidak ditemukan untuk ${device.name}, melewati inisialisasi`);
                await db.updateDeviceStatus(device.name, 'disconnected', null, null, 'Session not found');
            }
        }
    }
    console.log('[WWS] Selesai mencoba menginisialisasi ulang klien yang sudah ada.');
};

module.exports = {
    setSocketIo,
    startWhatsappClient,
    sendMessage,
    logoutWhatsappClient,
    getAllClientStatuses,
    initializeExistingClients,
    validateNumber,
    getClientStatus,
    clients
};

