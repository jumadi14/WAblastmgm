// src/services/messageScheduler.js
const whatsappService = require('./whatsappService');
const db = require('./db');
const path = require('path');
const fs = require('fs-extra'); // Untuk memeriksa keberadaan file gambar

// Queue untuk menyimpan blast yang akan diproses
const blastQueue = [];
let isProcessingQueue = false;

/**
 * Mengganti placeholder {nama} di template dengan nama penerima.
 * @param {string} templateContent - Isi template pesan.
 * @param {string} recipientName - Nama penerima.
 * @returns {string} Pesan yang sudah dipersonalisasi.
 */
const personalizeMessage = (templateContent, recipientName) => {
    return templateContent.replace(/{nama}/g, recipientName);
};

/**
 * Fungsi untuk memproses antrean blast secara berurutan.
 */
const processQueue = async () => {
    if (isProcessingQueue || blastQueue.length === 0) {
        return;
    }

    isProcessingQueue = true;
    console.log('[Scheduler] Memulai pemrosesan antrean blast...');

    while (blastQueue.length > 0) {
        const blast = blastQueue[0]; // Ambil blast pertama dari antrean
        const { contacts, intervalSeconds, templateName, deviceName, imageId } = blast;

        let templateContent = '';
        if (templateName) {
            try {
                const templates = await db.getTemplates();
                const foundTemplate = templates.find(t => t.name === templateName);
                if (foundTemplate) {
                    templateContent = foundTemplate.content;
                } else {
                    console.warn(`[Scheduler] Template '${templateName}' tidak ditemukan. Menggunakan pesan kosong.`);
                }
            } catch (error) {
                console.error(`[Scheduler] Gagal mengambil template '${templateName}':`, error);
            }
        }

        console.log(`[Scheduler] Memproses blast untuk perangkat '${deviceName}' dengan ${contacts.length} kontak.`);

        for (let i = 0; i < contacts.length; i++) {
            const contact = contacts[i];
            const personalizedMessage = personalizeMessage(templateContent, contact.recipientName || '');
            const finalMessage = personalizedMessage || contact.additionalMessage || ''; // Gunakan template, atau additionalMessage jika ada

            // Pastikan mediaPath adalah path yang benar ke file di server
            let mediaPath = null;
            if (imageId) {
                mediaPath = path.join(process.cwd(), 'uploads', imageId);
                // Verifikasi apakah file gambar benar-benar ada
                if (!fs.existsSync(mediaPath)) {
                    console.error(`[Scheduler] File gambar tidak ditemukan di path: ${mediaPath}. Mengirim pesan tanpa gambar.`);
                    mediaPath = null;
                }
            }

            try {
                // Panggil whatsappService.sendMessage
                console.log(`[Scheduler] Mengirim pesan ke ${contact.number} (via ${deviceName})...`);
                await whatsappService.sendMessage(deviceName, contact.number, finalMessage, mediaPath);
                console.log(`[Scheduler] Pesan berhasil dikirim ke ${contact.number}.`);
            } catch (error) {
                console.error(`[Scheduler] Gagal mengirim pesan ke ${contact.number} (via ${deviceName}):`, error);
                // Lanjutkan ke kontak berikutnya meskipun ada error
            }

            // Jeda antar pesan, kecuali untuk pesan terakhir
            if (i < contacts.length - 1) {
                console.log(`[Scheduler] Menunggu ${intervalSeconds} detik sebelum pesan berikutnya...`);
                await new Promise(resolve => setTimeout(resolve, intervalSeconds * 1000));
            }
        }

        // Hapus blast yang sudah selesai dari antrean
        blastQueue.shift();
        console.log(`[Scheduler] Blast selesai. Sisa blast di antrean: ${blastQueue.length}`);
    }

    isProcessingQueue = false;
    console.log('[Scheduler] Pemrosesan antrean blast selesai.');
};

/**
 * Menjadwalkan sebuah blast pesan.
 * @param {object} blastPayload - Payload blast dari frontend.
 */
const scheduleBlast = (blastPayload) => {
    const { scheduledTime } = blastPayload;
    const now = Date.now();
    const delay = scheduledTime - now; // Hitung delay dalam milidetik

    if (delay <= 0) {
        console.log('[Scheduler] Waktu terjadwal sudah lewat atau sekarang. Menambahkan ke antrean segera.');
        blastQueue.push(blastPayload);
        processQueue(); // Langsung proses jika waktu sudah lewat/sekarang
    } else {
        console.log(`[Scheduler] Menjadwalkan blast dalam ${delay / 1000} detik.`);
        setTimeout(() => {
            blastQueue.push(blastPayload);
            processQueue();
        }, delay);
    }
};

module.exports = {
    scheduleBlast
};

