// src/routes/whatsappRoutes.js

const express = require('express');
const whatsappService = require('../services/whatsappService');
const db = require('../services/db');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const messageScheduler = require('../services/messageScheduler');

// Fungsi helper sederhana untuk validasi format nomor telepon
const validatePhoneNumber = (number) => {
    // Menghapus semua karakter non-digit dan non-plus
    const cleanedNumber = number.replace(/[^\d+]/g, '');
    // Memastikan dimulai dengan kode negara (misal '62') dan panjangnya masuk akal
    return cleanedNumber.startsWith('62') && cleanedNumber.length >= 9 && cleanedNumber.length <= 15;
};

// --- FUNGSI HELPER BARU: Mengganti placeholder dengan data kontak ---
const replacePlaceholders = (templateContent, contact) => {
    let finalMessage = templateContent;
    if (contact) {
        if (contact.recipientName) {
            finalMessage = finalMessage.replace(/{Nama}/g, contact.recipientName);
            finalMessage = finalMessage.replace(/{nama}/g, contact.recipientName); // Untuk jaga-jaga
        }
        if (contact.number) {
            finalMessage = finalMessage.replace(/{hp}/g, contact.number);
        }
    }
    return finalMessage;
};

module.exports = (upload) => {
    const router = express.Router();
    
    // GET /api/whatsapp/devices - Mendapatkan status semua perangkat
    router.get('/devices', async (req, res) => {
        try {
            const statuses = await whatsappService.getAllClientStatuses();
            res.json(statuses);
        } catch (error) {
            console.error('[Backend Error] Error fetching device statuses:', error.message);
            res.status(500).json({
                error: 'Failed to fetch device statuses',
                details: error.message
            });
        }
    });

    // POST /api/whatsapp/validate-number - Memvalidasi nomor WhatsApp
    router.post('/validate-number', async (req, res) => {
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
                const isValid = await whatsappService.validateNumber(deviceName, num);
                validationResults.push({ number: num, isValid });
            } catch (error) {
                console.error('[Backend Error] Error validating number:', error.message);
                validationResults.push({ number: num, isValid: false, error: error.message });
            }
        }
        
        res.status(200).json({ validationResults });
    });

    // POST /api/whatsapp/start - Memulai klien WhatsApp baru
    router.post('/start', async (req, res) => {
        const { deviceName } = req.body;
        if (!deviceName) {
            return res.status(400).json({ error: 'Device name is required.' });
        }
        
        try {
            console.log(`[Backend Log] Menerima permintaan /whatsapp/start untuk: ${deviceName}`);
            const result = await whatsappService.startWhatsappClient(deviceName);
            res.status(200).json(result);
        } catch (error) {
            console.error(`[Backend Error] Gagal memulai klien ${deviceName}:`, error);
            res.status(500).json({ error: `Failed to start client: ${error.message}` });
        }
    });

    // POST /api/whatsapp/send-message - Mengirim pesan
    router.post('/send-message', upload.single('media'), async (req, res) => {
        const { deviceName, to, message } = req.body;
        const mediaPath = req.file ? req.file.path : null;

        if (!deviceName || !to || (!message && !mediaPath)) {
            return res.status(400).json({ error: 'Device name, recipient, and message/media are required.' });
        }
        
        if (!validatePhoneNumber(to)) {
            const failedMessage = {
                id: uuidv4(),
                deviceName,
                toNumber: to,
                message: message || 'Pesan dengan media',
                mediaPath,
                status: 'failed',
                error: 'Nomor telepon tidak valid.',
                timestamp: new Date().toISOString()
            };
            await db.saveOutgoingMessage(failedMessage);
            console.error('[API] Kirim Pesan: Gagal mengirim, nomor tidak valid:', to);
            return res.status(400).json({ error: 'Nomor telepon tidak valid.' });
        }

        try {
            const sendResult = await whatsappService.sendMessage(deviceName, to, message, mediaPath);
            
            const messageData = {
                id: sendResult.whatsappMessageId || uuidv4(),
                deviceName,
                toNumber: to,
                message: message || '',
                mediaPath,
                status: sendResult.success ? 'sent' : 'failed',
                error: sendResult.error || null,
                timestamp: new Date().toISOString()
            };
            await db.saveOutgoingMessage(messageData);

            if (sendResult.success) {
                res.status(200).json({
                    message: 'Message sent successfully',
                    whatsappMessageId: sendResult.whatsappMessageId,
                    sendDuration: sendResult.sendDuration
                });
            } else {
                res.status(500).json({ error: sendResult.error || 'Failed to send message' });
            }
        } catch (error) {
            console.error('[Backend Error] Error sending message:', error);
            res.status(500).json({ error: 'Failed to send message', details: error.message });
        }
    });

    // POST /api/whatsapp/logout - Logout klien WhatsApp
    router.post('/logout', async (req, res) => {
        const { deviceName } = req.body;
        if (!deviceName) {
            return res.status(400).json({ error: 'Device name is required.' });
        }
        try {
            const result = await whatsappService.logoutWhatsappClient(deviceName);
            res.status(200).json(result);
        } catch (error) {
            console.error('[Backend Error] Error logging out:', error);
            res.status(500).json({ error: `Failed to logout: ${error.message}` });
        }
    });

    // GET /api/whatsapp/templates - Mendapatkan semua template pesan
    router.get('/templates', async (req, res) => {
        try {
            const templates = await db.getTemplates();
            res.json(templates);
        } catch (error) {
            console.error('[Backend Error] Error fetching templates:', error.message);
            res.status(500).json({ error: 'Failed to fetch templates', details: error.message });
        }
    });

    // POST /api/whatsapp/templates - Menambahkan template baru
    router.post('/templates', async (req, res) => {
        const { name, content } = req.body;
        if (!name || !content) {
            return res.status(400).json({ error: 'Template name and content are required.' });
        }
        try {
            const result = await db.addTemplate(name, content);
            res.status(201).json({ message: 'Template added successfully', template: result });
        } catch (error) {
            console.error('[Backend Error] Error adding template:', error.message);
            res.status(500).json({ error: 'Failed to add template', details: error.message });
        }
    });

    // DELETE /api/whatsapp/templates/:name - Menghapus template
    router.delete('/templates/:name', async (req, res) => {
        const { name } = req.params;
        try {
            const result = await db.deleteTemplate(name);
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

    // POST /api/blast-excel - Rute untuk menjadwalkan pesan blast dari Excel
    router.post('/blast-excel', async (req, res) => {
        console.log('🚀 BLAST EXCEL REQUEST DITERIMA:', req.body);
        const { contacts, scheduledTime, intervalSeconds, templateName, deviceName, imageId } = req.body;
        if (!contacts || contacts.length === 0 || !scheduledTime || !intervalSeconds || !deviceName || !templateName) {
            console.error('[API] Blast Excel: Data input tidak lengkap atau tidak valid.');
            return res.status(400).json({ error: 'Missing required fields: contacts, scheduledTime, intervalSeconds, deviceName, templateName.' });
        }

        try {
            const foundTemplate = await db.getTemplateByName(templateName);
            if (!foundTemplate) {
                console.warn(`[API] Blast Excel: Template '${templateName}' tidak ditemukan.`);
                return res.status(404).json({ error: `Template '${templateName}' tidak ditemukan.` });
            }
            const templateContent = foundTemplate.content;
            console.log(`[API] Blast Excel: Template '${templateName}' ditemukan.`);

            let mediaPath = null;
            if (imageId) {
                const uploadDir = path.join(process.cwd(), 'uploads');
                const fullImagePath = path.join(uploadDir, imageId);
                if (fs.existsSync(fullImagePath)) {
                    mediaPath = fullImagePath;
                    console.log(`[API] Blast Excel: File gambar ditemukan di path: ${mediaPath}.`);
                } else {
                    console.warn(`[API] Blast Excel: File gambar tidak ditemukan di path: ${fullImagePath}.`);
                }
            }

            const messageIdsToSchedule = [];
            const now = new Date();
            const scheduledDate = new Date(scheduledTime);
            const effectiveScheduledTime = scheduledDate > now ? scheduledDate.toISOString() : now.toISOString();

            for (const contact of contacts) {
                if (contact.number) {
                    if (!validatePhoneNumber(contact.number)) {
                        console.warn(`[API] Blast Excel: Nomor tidak valid, pesan ke '${contact.number}' akan dicatat sebagai gagal.`);
                        const failedMessage = {
                            id: uuidv4(),
                            deviceName,
                            toNumber: contact.number,
                            message: 'Nomor telepon tidak valid.',
                            mediaPath: mediaPath,
                            status: 'failed',
                            error: 'Nomor telepon tidak valid.',
                            timestamp: effectiveScheduledTime
                        };
                        await db.saveOutgoingMessage(failedMessage);
                        continue;
                    }
                    
                    const personalizedMessage = replacePlaceholders(templateContent, contact);

                    const messageId = uuidv4();
                    const messageData = {
                        id: messageId,
                        deviceName,
                        toNumber: contact.number,
                        message: personalizedMessage,
                        mediaPath: mediaPath,
                        status: 'pending',
                        timestamp: effectiveScheduledTime
                    };
                    await db.saveOutgoingMessage(messageData);
                    messageIdsToSchedule.push(messageId);
                }
            }

            if (messageIdsToSchedule.length > 0) {
                messageScheduler.scheduleBlast({
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
    
    // GET /api/whatsapp/inbox-messages - Mendapatkan pesan masuk
    router.get('/inbox-messages', async (req, res) => {
        try {
            const { status, deviceName, excludeFrom } = req.query;

            let excludeFromArray = [];
            if (excludeFrom) {
                if (Array.isArray(excludeFrom)) {
                    excludeFromArray = excludeFrom;
                } else {
                    excludeFromArray = [excludeFrom];
                }
            }
            
            const messages = await db.getIncomingMessages({ 
                status, 
                deviceName: deviceName !== 'all' ? deviceName : undefined, 
                excludeFrom: excludeFromArray 
            });
            res.json(messages);
        } catch (error) {
            console.error('[Backend Error] Error fetching inbox messages:', error.message);
            res.status(500).json({ error: 'Failed to fetch inbox messages.', details: error.message });
        }
    });

    // GET /api/whatsapp/messages - Mendapatkan riwayat pesan keluar
    router.get('/messages', async (req, res) => {
        try {
            const { status, deviceName, limit, offset } = req.query;
            let statusArray = [];

            if (status) {
                if (Array.isArray(status)) {
                    statusArray = status;
                } else if (status === 'sent_delivered_played') {
                    statusArray = ['sent', 'delivered', 'played'];
                } else if (status === 'failed_or_revoked') {
                    statusArray = ['failed', 'revoked'];
                } else {
                    statusArray = [status];
                }
            }

            const messages = await db.getOutgoingMessages({ 
                status: statusArray.length > 0 ? statusArray : undefined, 
                deviceName: deviceName !== 'all' ? deviceName : undefined,
                limit: limit ? parseInt(limit, 10) : undefined,
                offset: offset ? parseInt(offset, 10) : 0
            });
            res.json(messages);
        } catch (error) {
            console.error('[Backend Error] Error fetching messages history:', error.message);
            res.status(500).json({ error: 'Failed to fetch messages history.', details: error.message });
        }
    });

    // --- Rute Baru untuk Dashboard ---

    // GET /api/whatsapp/messages/total - Mendapatkan ringkasan total pesan
    router.get('/messages/total', async (req, res) => {
        try {
            const summary = await db.getMessageSummary();
            res.json(summary);
        } catch (error) {
            console.error('[Backend Error] Error fetching message summary:', error.message);
            res.status(500).json({ 
                error: 'Gagal mengambil ringkasan pesan.', 
                details: error.message 
            });
        }
    });

    // GET /api/whatsapp/messages/recent - Mendapatkan 10 pesan keluar terakhir (SUDAH DIPERBAIKI)
    router.get('/messages/recent', async (req, res) => {
        try {
            // Memanggil fungsi getOutgoingMessages() yang lebih umum,
            // dan menambahkan parameter limit dan urutan untuk mendapatkan pesan terbaru.
            const { limit = 10 } = req.query;
            const recentMessages = await db.getOutgoingMessages({
                limit: parseInt(limit, 10),
                orderBy: 'timestamp',
                orderDirection: 'desc'
            });
            res.json(recentMessages);
        } catch (error) {
            console.error('[Backend Error] Error fetching recent messages:', error.message);
            res.status(500).json({
                error: 'Gagal memuat aktivitas terakhir.',
                details: error.message
            });
        }
    });
    // --- Akhir Rute Baru ---

    return router;
};

