// src/app.js

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs-extra');
const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');

// Import services dan routes
const db = require('./services/db');
const whatsappService = require('./services/whatsappService');
const messageScheduler = require('./services/messageScheduler');
const whatsappRoutes = require('./routes/whatsappRoutes');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    cors: {
        origin: ["http://localhost:5173", "http://192.168.167.158:5173"], // Tambahkan IP lokal di sini
        methods: ["GET", "POST", "PUT", "DELETE"]
    }
});

// Set Socket.IO instance di services
whatsappService.setSocketIo(io);
messageScheduler.setSocketIo(io);

// --- Konfigurasi Multer untuk upload file ---
const uploadDir = path.join(process.cwd(), 'uploads'); 
fs.ensureDirSync(uploadDir); // Pastikan direktori ada saat startup

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        // Gunakan UUID untuk mencegah duplikasi nama file
        const ext = path.extname(file.originalname);
        cb(null, `${uuidv4()}${ext}`);
    }
});
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 } // Batas ukuran file 10MB
});

// --- Middleware Express ---
app.use(cors({
    origin: ["http://localhost:5173", "http://192.168.167.158:5173"], // Tambahkan IP lokal di sini
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(uploadDir));

// --- Perbaikan: Middleware untuk penanganan error Multer secara global ---
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        console.error('[Middleware] Multer Error:', err.message);
        return res.status(400).json({ error: 'File upload error', details: err.message });
    } else if (err) {
        console.error('[Middleware] Unexpected Error:', err.message);
        return res.status(500).json({ error: 'An unexpected error occurred.', details: err.message });
    }
    next();
});

// --- Rute API untuk Health Check ---
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// --- Rute API untuk Upload Gambar ---
app.post('/api/images/upload', upload.single('image'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No image file uploaded.' });
    }
    const imageId = path.basename(req.file.filename); // Menggunakan filename yang dibuat Multer
    console.log(`[API] Upload Image: Gambar diunggah: ${imageId}`);
    res.json({ message: 'Image uploaded successfully', imageId: imageId });
});

// --- Rute API untuk Debugging ---
app.get('/api/debug/scheduler', (req, res) => {
    try {
        const queueStatus = messageScheduler.getQueueStatus();
        res.json(queueStatus);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Daftarkan Rute API
app.use('/api/whatsapp', whatsappRoutes(upload));

// --- Fungsi untuk memulai server ---
const startServer = async () => {
    try {
        await db.getDbInstance();
        console.log('[App] Koneksi database berhasil.');
        
        await whatsappService.initializeExistingClients();
        console.log('[App] Inisialisasi klien WhatsApp selesai.');

        await messageScheduler.reschedulePendingBlasts();
        console.log('[App] Pesan-pesan yang tertunda telah dijadwalkan ulang.');
        
        // Mulai server setelah semuanya siap
        server.listen(3000, '0.0.0.0', () => {
    console.log('Server berjalan di port 3000');
            // Jadwalkan cron job untuk memproses antrean setiap 30 detik
            cron.schedule('*/30 * * * * *', () => {
                // console.log(`[Cron] Memeriksa antrean pesan blast...`); // Nonaktifkan log ini agar tidak terlalu berisik
                messageScheduler.processQueue();
            });
            // --- Penambahan: Cron job untuk membersihkan file lama ---
            cron.schedule('0 0 * * *', () => { // Jalankan setiap tengah malam
                console.log('[Cron] Memulai pembersihan file lama...');
                cleanOldFiles(uploadDir, 24 * 60 * 60 * 1000); // Hapus file yang lebih tua dari 24 jam
            });
        });
    } catch (err) {
        console.error('[App] Gagal terhubung ke database atau memulai server:', err);
        process.exit(1);
    }
};

const cleanOldFiles = (dir, maxAge) => {
    const now = Date.now();
    fs.readdir(dir, (err, files) => {
        if (err) {
            console.error('[File Cleanup] Gagal membaca direktori:', err);
            return;
        }
        files.forEach(file => {
            const filePath = path.join(dir, file);
            fs.stat(filePath, (err, stat) => {
                if (err) {
                    console.error(`[File Cleanup] Gagal mendapatkan status file ${filePath}:`, err);
                    return;
                }
                if ((now - stat.mtimeMs) > maxAge) {
                    fs.remove(filePath, err => {
                        if (err) {
                            console.error(`[File Cleanup] Gagal menghapus file ${filePath}:`, err);
                        } else {
                            console.log(`[File Cleanup] Berhasil menghapus file lama: ${filePath}`);
                        }
                    });
                }
            });
        });
    });
};

startServer();

// --- Penanganan Error Global ---
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
