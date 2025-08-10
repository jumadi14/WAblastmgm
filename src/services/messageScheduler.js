// src/services/messageScheduler.js
const whatsappService = require('./whatsappService');
const db = require('./db');
const path = require('path');
const fs = require('fs-extra');

const blastQueue = [];
let isProcessingQueue = false;
let io;

const setSocketIo = (socketIo) => {
    io = socketIo;
};

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

            const clientStatus = await whatsappService.getClientStatus(deviceName);
            console.log(`[Scheduler] Status klien ${deviceName}:`, clientStatus.status);
            const validStatuses = ['connected', 'authenticated'];

            if (!validStatuses.includes(clientStatus.status)) {
                console.error(`[Scheduler] ❌ Perangkat ${deviceName} tidak terhubung. Mengubah status pesan menjadi failed.`);
                sendStatusUpdate('failed', `Perangkat ${deviceName} tidak terhubung. Pengiriman dibatalkan.`);
                for (const messageId of messageIds) {
                    await db.updateOutgoingMessageStatus(messageId, 'failed', `Device not connected`);
                }
                blastQueue.shift();
                continue;
            }

            console.log(`[Scheduler] ✅ Perangkat ${deviceName} terhubung, memulai pengiriman...`);

            for (let i = 0; i < messageIds.length; i++) {
                const messageId = messageIds[i];
                console.log(`[Scheduler] Memproses pesan ID: ${messageId}`);

                const messageData = await db.getOutgoingMessageById(messageId);
                
                if (!messageData) {
                    console.warn(`[Scheduler] Pesan dengan ID ${messageId} tidak ditemukan di database. Melewati.`);
                    const messageIndex = blastQueue[0].messageIds.indexOf(messageId);
                    if (messageIndex > -1) {
                        blastQueue[0].messageIds.splice(messageIndex, 1);
                    }
                    continue;
                }

                if (messageData.status !== 'pending') {
                    console.warn(`[Scheduler] Pesan dengan ID ${messageId} sudah memiliki status '${messageData.status}'. Melewati.`);
                    const messageIndex = blastQueue[0].messageIds.indexOf(messageId);
                    if (messageIndex > -1) {
                        blastQueue[0].messageIds.splice(messageIndex, 1);
                    }
                    continue;
                }
                
                sendStatusUpdate('info', `Mengirim pesan ${i + 1} dari ${messageIds.length} untuk perangkat ${deviceName}...`);

                const { toNumber, message, mediaPath } = messageData;
                
                const sendResult = await whatsappService.sendMessage(deviceName, toNumber, message, mediaPath, messageId);

                if (sendResult.success) {
                    console.log(`[Scheduler] ✅ Pesan ID ${messageId} berhasil dikirim. WhatsApp ID: ${sendResult.whatsappMessageId}`);
                    await db.updateOutgoingMessageStatus(messageId, 'sent', null);
                } else {
                    console.error(`[Scheduler] ❌ Gagal mengirim pesan ID ${messageId}: ${sendResult.error}`);
                    await db.updateOutgoingMessageStatus(messageId, 'failed', sendResult.error);
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
        setTimeout(processQueue, 5000);
    }
};

const scheduleBlast = async (blastJob) => {
    blastQueue.push(blastJob);
    console.log(`[Scheduler] Menambahkan blast baru ke antrean. Total item: ${blastQueue.length}`);
    processQueue();
};

const reschedulePendingBlasts = async () => {
    console.log('[Scheduler] Memeriksa pesan yang tertunda untuk dijadwalkan ulang...');
    
    // Ambil hanya pesan dengan status 'pending' dari database
    const pendingMessages = await db.getOutgoingMessages({ status: 'pending' });

    if (pendingMessages.length === 0) {
        console.log('[Scheduler] Tidak ada pesan tertunda. Selesai.');
        return;
    }

    const blastsToReschedule = {};
    for (const msg of pendingMessages) {
        // PERBAIKAN: Hanya proses jika ID-nya adalah angka
        if (isNaN(msg.id)) {
            console.warn(`[Scheduler] Pesan dengan ID non-numerik '${msg.id}' dilewati.`);
            continue;
        }

        if (!msg.deviceName || !msg.timestamp) {
            console.warn(`[Scheduler] Pesan ${msg.id} dilewati karena data tidak valid: deviceName atau timestamp kosong.`);
            await db.updateOutgoingMessageStatus(msg.id, 'failed', 'Invalid data for reschedule');
            continue;
        }

        const interval = msg.intervalSeconds || 10;
        const key = `${msg.deviceName}_${interval}_${msg.timestamp}`;

        if (!blastsToReschedule[key]) {
            blastsToReschedule[key] = {
                messageIds: [],
                deviceName: msg.deviceName,
                intervalSeconds: interval,
                scheduledTime: msg.timestamp
            };
        }
        blastsToReschedule[key].messageIds.push(msg.id);
    }

    if (Object.keys(blastsToReschedule).length === 0) {
        console.log('[Scheduler] Tidak ada blast valid untuk dijadwalkan ulang.');
        return;
    }

    console.log(`[Scheduler] Menjadwalkan ulang ${Object.keys(blastsToReschedule).length} blast...`);
    for (const key in blastsToReschedule) {
        await scheduleBlast(blastsToReschedule[key]);
    }
};

const getQueueStatus = () => ({
    isProcessingQueue,
    queueLength: blastQueue.length,
    queueItems: blastQueue.map(item => ({
        deviceName: item.deviceName,
        messageCount: item.messageIds.length,
        intervalSeconds: item.intervalSeconds,
        scheduledTime: item.scheduledTime
    }))
});

module.exports = {
    setSocketIo,
    scheduleBlast,
    reschedulePendingBlasts,
    getQueueStatus,
    processQueue
};

