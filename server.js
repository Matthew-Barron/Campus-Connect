/**
 * Campus Connect - Backend Server
 * 
 * A complete Express.js backend for the Campus Connect platform
 * Handles authentication, listings, events, polls, societies, tutoring, and notifications
 * 
 * Features:
 * - User authentication with JWT
 * - Complete CRUD operations for all entities
 * - Role-based access control
 * - Input validation and error handling
 * - Database connection pooling
 * 
 * Author: Matthew
 * Date: October 5, 2026
 */

import express from 'express';
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cors from 'cors';
import helmet from 'helmet';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

// ============================================================================
// CONFIGURATION
// ============================================================================

const app = express();
const PORT = process.env.PORT || 5000;
const IS_PROD = process.env.NODE_ENV === 'production';
const JWT_SECRET = process.env.JWT_SECRET || 'campus-connect-secret-key-change-in-production';
if (IS_PROD && !process.env.JWT_SECRET) {
    console.error('FATAL: JWT_SECRET must be set in production');
    process.exit(1);
}
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Database connection pool
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'password',
    database: process.env.DB_NAME || 'campus_connect',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: 'utf8mb4_unicode_ci'
});

// ============================================================================
// MIDDLEWARE
// ============================================================================

app.use(helmet({
    contentSecurityPolicy: {
        useDefaults: true,
        // Don't force https:// for sub-resources; breaks plain-http local/LAN deployments
        directives: { upgradeInsecureRequests: null }
    }
}));
app.use(cors({
    origin: process.env.FRONTEND_URL || true,
    credentials: true
}));
app.use(express.json({ limit: '100kb' }));
// Frontend is served from the same origin, so no CORS setup is needed for it
app.use(express.static(path.join(__dirname, 'public')));

// Minimal in-memory rate limiter (per IP) for sensitive endpoints
const rateBuckets = new Map();
const rateLimit = (max, windowMs) => (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const bucket = (rateBuckets.get(key) || []).filter(t => now - t < windowMs);
    if (bucket.length >= max) {
        return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    }
    bucket.push(now);
    rateBuckets.set(key, bucket);
    next();
};
setInterval(() => rateBuckets.clear(), 60 * 60 * 1000).unref();

// Helpers
const toInt = (v, def, min, max) => {
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) return def;
    return Math.min(Math.max(n, min), max);
};
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const parseJSON = (v) => (typeof v === 'string' ? JSON.parse(v) : v); // mysql2 returns JSON columns already parsed

// Authentication middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(401).json({ error: 'Session expired. Please log in again.' });
        req.user = user;
        next();
    });
};

// Attaches req.user when a valid token is present, but never rejects
const optionalAuth = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return next();
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (!err) req.user = user;
        next();
    });
};

// Error handler
const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

// ============================================================================
// AUTH ROUTES
// ============================================================================

/**
 * POST /auth/register
 * Create a new user account
 * Body: { name, email, password, student_number }
 */
app.post('/auth/register', rateLimit(10, 15 * 60 * 1000), asyncHandler(async (req, res) => {
    const name = str(req.body.name);
    const email = str(req.body.email).toLowerCase();
    const student_number = str(req.body.student_number);
    const password = typeof req.body.password === 'string' ? req.body.password : '';

    // Validation
    if (!name || !email || !password || !student_number) {
        return res.status(400).json({ error: 'All fields required' });
    }
    if (name.length > 100 || student_number.length > 20 || email.length > 120) {
        return res.status(400).json({ error: 'One or more fields are too long' });
    }

    if (password.length < 8 || !/\d/.test(password) || !/[a-zA-Z]/.test(password)) {
        return res.status(400).json({ error: 'Password must be at least 8 characters with a letter and number' });
    }

    // Verify student email domain
    if (!/^[^\s@]+@campus\.ac\.za$/.test(email)) {
        return res.status(400).json({ error: 'Must use valid campus email address' });
    }

    const connection = await pool.getConnection();
    try {
        // Check if email exists
        const [existingEmail] = await connection.query('SELECT user_id FROM Users WHERE email = ?', [email]);
        if (existingEmail.length > 0) {
            return res.status(409).json({ error: 'Email already registered' });
        }

        // Check if student number exists
        const [existingStudent] = await connection.query('SELECT user_id FROM Users WHERE student_number = ?', [student_number]);
        if (existingStudent.length > 0) {
            return res.status(409).json({ error: 'Student number already registered' });
        }

        // Hash password
        const password_hash = await bcrypt.hash(password, 10);

        // Create user
        const [result] = await connection.query(
            'INSERT INTO Users (name, email, password_hash, student_number) VALUES (?, ?, ?, ?)',
            [name, email, password_hash, student_number]
        );

        const user_id = result.insertId;
        const token = jwt.sign({ user_id, email, role: 'Student' }, JWT_SECRET, { expiresIn: '24h' });

        res.status(201).json({
            message: 'Account created successfully',
            user_id,
            token,
            user: { user_id, name, email, role: 'Student' }
        });
    } finally {
        connection.release();
    }
}));

/**
 * POST /auth/login
 * Authenticate user and return JWT token
 * Body: { email, password }
 */
app.post('/auth/login', rateLimit(20, 15 * 60 * 1000), asyncHandler(async (req, res) => {
    const email = str(req.body.email).toLowerCase();
    const password = typeof req.body.password === 'string' ? req.body.password : '';

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
    }

    const connection = await pool.getConnection();
    try {
        const [users] = await connection.query('SELECT * FROM Users WHERE email = ? AND is_active = TRUE', [email]);

        if (users.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const user = users[0];
        const passwordMatch = await bcrypt.compare(password, user.password_hash);

        if (!passwordMatch) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = jwt.sign({ user_id: user.user_id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '24h' });

        res.json({
            message: 'Login successful',
            token,
            user: { user_id: user.user_id, name: user.name, email: user.email, role: user.role }
        });
    } finally {
        connection.release();
    }
}));

/**
 * POST /auth/forgot-password
 * Request password reset
 * Body: { email, student_number }
 */
app.post('/auth/forgot-password', rateLimit(5, 15 * 60 * 1000), asyncHandler(async (req, res) => {
    const email = str(req.body.email).toLowerCase();
    const student_number = str(req.body.student_number);

    if (!email || !student_number) {
        return res.status(400).json({ error: 'Email and student number required' });
    }

    const connection = await pool.getConnection();
    try {
        const [users] = await connection.query(
            'SELECT user_id FROM Users WHERE email = ? AND student_number = ?',
            [email, student_number]
        );

        if (users.length === 0) {
            // Same response as success so accounts can't be enumerated
            return res.json({ message: 'If those details match an account, a reset code has been sent.' });
        }

        const reset_token = uuidv4();
        const reset_token_expiry = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

        await connection.query(
            'UPDATE Users SET reset_token = ?, reset_token_expiry = ? WHERE user_id = ?',
            [reset_token, reset_token_expiry, users[0].user_id]
        );

        // TODO: send the token by email. It is only returned in the response in
        // development so the flow can be tested without a mail server; returning
        // it in production would let anyone who knows an email + student number
        // take over the account.
        res.json({
            message: 'If those details match an account, a reset code has been sent.',
            ...(IS_PROD ? {} : { reset_token })
        });
    } finally {
        connection.release();
    }
}));

/**
 * POST /auth/reset-password
 * Reset password using reset token
 * Body: { reset_token, new_password }
 */
app.post('/auth/reset-password', rateLimit(10, 15 * 60 * 1000), asyncHandler(async (req, res) => {
    const { reset_token, new_password } = req.body;

    if (!reset_token || !new_password) {
        return res.status(400).json({ error: 'Reset token and password required' });
    }

    if (new_password.length < 8 || !/\d/.test(new_password) || !/[a-zA-Z]/.test(new_password)) {
        return res.status(400).json({ error: 'Password must be at least 8 characters with a letter and number' });
    }

    const connection = await pool.getConnection();
    try {
        const [users] = await connection.query(
            'SELECT user_id FROM Users WHERE reset_token = ? AND reset_token_expiry > NOW()',
            [reset_token]
        );

        if (users.length === 0) {
            return res.status(400).json({ error: 'Invalid or expired reset token' });
        }

        const password_hash = await bcrypt.hash(new_password, 10);
        await connection.query(
            'UPDATE Users SET password_hash = ?, reset_token = NULL, reset_token_expiry = NULL WHERE user_id = ?',
            [password_hash, users[0].user_id]
        );

        res.json({ message: 'Password reset successfully' });
    } finally {
        connection.release();
    }
}));

/**
 * GET /auth/me
 * Validate the current token and return the user
 */
app.get('/auth/me', authenticateToken, asyncHandler(async (req, res) => {
    const [users] = await pool.query(
        'SELECT user_id, name, email, role FROM Users WHERE user_id = ? AND is_active = TRUE',
        [req.user.user_id]
    );
    if (users.length === 0) return res.status(401).json({ error: 'Account not found' });
    res.json({ user: users[0] });
}));

// ============================================================================
// MARKETPLACE ROUTES
// ============================================================================

const LISTING_STATUSES = ['Available', 'Pending', 'Sold'];

/**
 * POST /listings
 * Create a new marketplace listing
 * Body: { title, description, price, status }
 */
app.post('/listings', authenticateToken, asyncHandler(async (req, res) => {
    const title = str(req.body.title);
    const description = str(req.body.description);
    const price = Number(req.body.price);
    const status = LISTING_STATUSES.includes(req.body.status) ? req.body.status : 'Available';
    const user_id = req.user.user_id;

    if (!title || req.body.price === undefined || req.body.price === '') {
        return res.status(400).json({ error: 'Title and price required' });
    }
    if (title.length > 150) {
        return res.status(400).json({ error: 'Title must be 150 characters or fewer' });
    }
    if (!Number.isFinite(price) || price <= 0 || price >= 100000000) {
        return res.status(400).json({ error: 'Price must be greater than 0' });
    }

    const connection = await pool.getConnection();
    try {
        const [result] = await connection.query(
            'INSERT INTO Listings (user_id, title, description, price, status) VALUES (?, ?, ?, ?, ?)',
            [user_id, title, description, price, status]
        );

        res.status(201).json({
            message: 'Listing created',
            listing_id: result.insertId
        });
    } finally {
        connection.release();
    }
}));

/**
 * GET /listings
 * Get all marketplace listings (paginated)
 * Query: { status, page, limit }
 */
app.get('/listings', asyncHandler(async (req, res) => {
    const status = LISTING_STATUSES.includes(req.query.status) ? req.query.status : null;
    const search = str(req.query.search);
    const page = toInt(req.query.page, 1, 1, 100000);
    const limit = toInt(req.query.limit, 20, 1, 100);
    const offset = (page - 1) * limit;

    const connection = await pool.getConnection();
    try {
        let query = 'SELECT l.*, u.name as seller_name FROM Listings l JOIN Users u ON l.user_id = u.user_id';
        const params = [];
        const where = [];

        if (status) { where.push('l.status = ?'); params.push(status); }
        if (search) {
            where.push('(l.title LIKE ? OR l.description LIKE ?)');
            params.push(`%${search}%`, `%${search}%`);
        }
        if (where.length) query += ' WHERE ' + where.join(' AND ');

        query += ` ORDER BY l.created_at DESC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        const [rows] = await connection.query(query, params);
        // DECIMAL columns come back as strings; the client expects numbers
        const listings = rows.map(l => ({ ...l, price: Number(l.price) }));

        res.json({ listings, pagination: { page, limit } });
    } finally {
        connection.release();
    }
}));

/**
 * GET /listings/:listing_id
 * Get a single listing with responses
 */
app.get('/listings/:listing_id', optionalAuth, asyncHandler(async (req, res) => {
    const { listing_id } = req.params;

    const connection = await pool.getConnection();
    try {
        const [listings] = await connection.query(
            'SELECT l.*, u.name as seller_name, u.email as seller_email FROM Listings l JOIN Users u ON l.user_id = u.user_id WHERE l.listing_id = ?',
            [listing_id]
        );

        if (listings.length === 0) {
            return res.status(404).json({ error: 'Listing not found' });
        }

        const listing = { ...listings[0], price: Number(listings[0].price) };
        const is_owner = !!req.user && req.user.user_id === listing.user_id;

        // Only the seller can see the messages buyers have sent
        let responses = [];
        if (is_owner) {
            [responses] = await connection.query(
                'SELECT r.*, u.name as responder_name, u.email as responder_email FROM Listing_Responses r JOIN Users u ON r.responder_id = u.user_id WHERE r.listing_id = ? ORDER BY r.created_at DESC',
                [listing_id]
            );
        }
        // Seller email is only shown to logged-in students
        if (!req.user) delete listing.seller_email;

        res.json({ listing, responses, is_owner });
    } finally {
        connection.release();
    }
}));

/**
 * PUT /listings/:listing_id
 * Update a listing (owner only)
 */
app.put('/listings/:listing_id', authenticateToken, asyncHandler(async (req, res) => {
    const { listing_id } = req.params;
    const { title, description, price, status } = req.body;
    const user_id = req.user.user_id;

    const connection = await pool.getConnection();
    try {
        // Check ownership
        const [listings] = await connection.query('SELECT user_id FROM Listings WHERE listing_id = ?', [listing_id]);

        if (listings.length === 0) {
            return res.status(404).json({ error: 'Listing not found' });
        }

        if (listings[0].user_id !== user_id) {
            return res.status(403).json({ error: 'Not authorized' });
        }

        const fields = [];
        const params = [];
        if (title !== undefined) {
            if (!str(title) || str(title).length > 150) return res.status(400).json({ error: 'Invalid title' });
            fields.push('title = ?'); params.push(str(title));
        }
        if (description !== undefined) { fields.push('description = ?'); params.push(str(description)); }
        if (price !== undefined) {
            const p = Number(price);
            if (!Number.isFinite(p) || p <= 0) return res.status(400).json({ error: 'Price must be greater than 0' });
            fields.push('price = ?'); params.push(p);
        }
        if (status !== undefined) {
            if (!LISTING_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
            fields.push('status = ?'); params.push(status);
        }
        if (fields.length === 0) return res.status(400).json({ error: 'Nothing to update' });

        await connection.query(`UPDATE Listings SET ${fields.join(', ')} WHERE listing_id = ?`, [...params, listing_id]);

        res.json({ message: 'Listing updated' });
    } finally {
        connection.release();
    }
}));

/**
 * DELETE /listings/:listing_id
 * Delete a listing (owner only)
 */
app.delete('/listings/:listing_id', authenticateToken, asyncHandler(async (req, res) => {
    const { listing_id } = req.params;
    const user_id = req.user.user_id;

    const connection = await pool.getConnection();
    try {
        const [listings] = await connection.query('SELECT user_id FROM Listings WHERE listing_id = ?', [listing_id]);

        if (listings.length === 0) {
            return res.status(404).json({ error: 'Listing not found' });
        }

        if (listings[0].user_id !== user_id) {
            return res.status(403).json({ error: 'Not authorized' });
        }

        await connection.query('DELETE FROM Listings WHERE listing_id = ?', [listing_id]);

        res.json({ message: 'Listing deleted' });
    } finally {
        connection.release();
    }
}));

/**
 * POST /listings/:listing_id/responses
 * Respond to a listing
 */
app.post('/listings/:listing_id/responses', authenticateToken, asyncHandler(async (req, res) => {
    const { listing_id } = req.params;
    const message = str(req.body.message);
    const responder_id = req.user.user_id;

    if (message.length < 1 || message.length > 500) {
        return res.status(400).json({ error: 'Message must be 1-500 characters' });
    }

    const connection = await pool.getConnection();
    try {
        // Check listing exists
        const [listings] = await connection.query('SELECT user_id FROM Listings WHERE listing_id = ?', [listing_id]);
        if (listings.length === 0) {
            return res.status(404).json({ error: 'Listing not found' });
        }
        if (listings[0].user_id === responder_id) {
            return res.status(400).json({ error: "You can't respond to your own listing" });
        }

        const [result] = await connection.query(
            'INSERT INTO Listing_Responses (listing_id, responder_id, message) VALUES (?, ?, ?)',
            [listing_id, responder_id, message]
        );

        // Let the seller know
        await connection.query(
            "INSERT INTO Notifications (user_id, type, message, related_listing_id) VALUES (?, 'Listing', ?, ?)",
            [listings[0].user_id, `${req.user.email} responded to your listing`, listing_id]
        );

        res.status(201).json({
            message: 'Response saved',
            response_id: result.insertId
        });
    } finally {
        connection.release();
    }
}));

// ============================================================================
// EVENTS ROUTES
// ============================================================================

/**
 * POST /events
 * Create a new event
 */
app.post('/events', authenticateToken, asyncHandler(async (req, res) => {
    const title = str(req.body.title);
    const description = str(req.body.description);
    const location = str(req.body.location);
    const date_time = str(req.body.date_time).replace('T', ' ');
    const organiser_id = req.user.user_id;

    if (!title || !date_time) {
        return res.status(400).json({ error: 'Title and date_time required' });
    }
    if (title.length > 150 || location.length > 200) {
        return res.status(400).json({ error: 'Title or location too long' });
    }
    if (Number.isNaN(new Date(date_time.replace(' ', 'T')).getTime())) {
        return res.status(400).json({ error: 'Invalid date' });
    }

    const connection = await pool.getConnection();
    try {
        const [result] = await connection.query(
            'INSERT INTO Events (organiser_id, title, description, date_time, location) VALUES (?, ?, ?, ?, ?)',
            [organiser_id, title, description, date_time, location]
        );

        // Create notification for all users
        await connection.query(
            `INSERT INTO Notifications (user_id, type, message, related_event_id) 
             SELECT user_id, 'Event', CONCAT('New event: ', ?), ? FROM Users WHERE user_id != ?`,
            [title, result.insertId, organiser_id]
        );

        res.status(201).json({
            message: 'Event created',
            event_id: result.insertId
        });
    } finally {
        connection.release();
    }
}));

/**
 * GET /events
 * Get all events
 */
app.get('/events', optionalAuth, asyncHandler(async (req, res) => {
    const page = toInt(req.query.page, 1, 1, 100000);
    const limit = toInt(req.query.limit, 50, 1, 100);
    const offset = (page - 1) * limit;
    const uid = req.user ? req.user.user_id : 0;

    const connection = await pool.getConnection();
    try {
        const [events] = await connection.query(
            `SELECT e.*, u.name as organiser_name,
                    COALESCE(ea.attending_count, 0) AS attending_count,
                    COALESCE(ea.interested_count, 0) AS interested_count,
                    mine.rsvp_status AS my_rsvp
             FROM Events e 
             JOIN Users u ON e.organiser_id = u.user_id 
             LEFT JOIN vw_event_attendance ea ON e.event_id = ea.event_id
             LEFT JOIN Event_RSVPs mine ON mine.event_id = e.event_id AND mine.user_id = ?
             WHERE e.date_time >= DATE_SUB(NOW(), INTERVAL 1 DAY)
             ORDER BY e.date_time ASC LIMIT ? OFFSET ?`,
            [uid, limit, offset]
        );

        res.json({ events, pagination: { page, limit } });
    } finally {
        connection.release();
    }
}));

/**
 * POST /events/:event_id/rsvp
 * RSVP to an event
 */
app.post('/events/:event_id/rsvp', authenticateToken, asyncHandler(async (req, res) => {
    const { event_id } = req.params;
    const { rsvp_status } = req.body;
    const user_id = req.user.user_id;

    const validStatuses = ['Attending', 'Not_Attending', 'Interested'];
    if (!validStatuses.includes(rsvp_status)) {
        return res.status(400).json({ error: 'Invalid RSVP status' });
    }

    const connection = await pool.getConnection();
    try {
        // Check event exists
        const [events] = await connection.query('SELECT event_id FROM Events WHERE event_id = ?', [event_id]);
        if (events.length === 0) {
            return res.status(404).json({ error: 'Event not found' });
        }

        // Insert or update RSVP
        await connection.query(
            `INSERT INTO Event_RSVPs (event_id, user_id, rsvp_status) VALUES (?, ?, ?) 
             ON DUPLICATE KEY UPDATE rsvp_status = VALUES(rsvp_status), updated_at = NOW()`,
            [event_id, user_id, rsvp_status]
        );

        res.json({ message: 'RSVP saved' });
    } finally {
        connection.release();
    }
}));

// ============================================================================
// POLLS ROUTES
// ============================================================================

/**
 * POST /polls
 * Create a new poll
 */
app.post('/polls', authenticateToken, asyncHandler(async (req, res) => {
    const question = str(req.body.question);
    const created_by = req.user.user_id;
    const options = Array.isArray(req.body.options)
        ? [...new Set(req.body.options.map(str).filter(Boolean))]
        : [];
    const closes_at = str(req.body.closes_at).replace('T', ' ');

    if (!question || options.length < 2) {
        return res.status(400).json({ error: 'Question and at least 2 different options required' });
    }
    if (question.length > 255 || options.length > 10 || options.some(o => o.length > 255)) {
        return res.status(400).json({ error: 'Question or options too long' });
    }
    const closesDate = new Date(closes_at.replace(' ', 'T'));
    if (!closes_at || Number.isNaN(closesDate.getTime()) || closesDate <= new Date()) {
        return res.status(400).json({ error: 'Closing time must be in the future' });
    }

    const connection = await pool.getConnection();
    try {
        const [result] = await connection.query(
            'INSERT INTO Polls (created_by, question, options, closes_at) VALUES (?, ?, ?, ?)',
            [created_by, question, JSON.stringify(options), closes_at]
        );

        res.status(201).json({
            message: 'Poll created',
            poll_id: result.insertId
        });
    } finally {
        connection.release();
    }
}));

/**
 * GET /polls
 * Get active polls
 */
app.get('/polls', optionalAuth, asyncHandler(async (req, res) => {
    const uid = req.user ? req.user.user_id : 0;
    const connection = await pool.getConnection();
    try {
        const [polls] = await connection.query(`
            SELECT p.*, u.name as creator_name,
                   (SELECT COUNT(*) FROM Poll_Votes WHERE poll_id = p.poll_id) as vote_count,
                   (SELECT selected_option FROM Poll_Votes WHERE poll_id = p.poll_id AND user_id = ?) as my_vote,
                   CASE WHEN p.closes_at > NOW() THEN 1 ELSE 0 END as is_active
            FROM Polls p 
            JOIN Users u ON p.created_by = u.user_id
            WHERE p.closes_at > DATE_SUB(NOW(), INTERVAL 7 DAY)
            ORDER BY is_active DESC, p.closes_at ASC
        `, [uid]);

        const [tallies] = await connection.query(
            'SELECT poll_id, selected_option, COUNT(*) AS votes FROM Poll_Votes GROUP BY poll_id, selected_option'
        );

        polls.forEach(p => {
            p.options = parseJSON(p.options);
            p.is_active = !!p.is_active;
            // Results are shown once you've voted or the poll has closed
            if (p.my_vote || !p.is_active) {
                p.results = {};
                p.options.forEach(o => { p.results[o] = 0; });
                tallies.filter(t => t.poll_id === p.poll_id).forEach(t => { p.results[t.selected_option] = Number(t.votes); });
            }
        });

        res.json({ polls });
    } finally {
        connection.release();
    }
}));

/**
 * POST /polls/:poll_id/vote
 * Submit a vote
 */
app.post('/polls/:poll_id/vote', authenticateToken, asyncHandler(async (req, res) => {
    const { poll_id } = req.params;
    const { selected_option } = req.body;
    const user_id = req.user.user_id;

    if (!selected_option) {
        return res.status(400).json({ error: 'Selected option required' });
    }

    const connection = await pool.getConnection();
    try {
        // Check poll exists and is active
        const [polls] = await connection.query(
            'SELECT closes_at, options FROM Polls WHERE poll_id = ?',
            [poll_id]
        );

        if (polls.length === 0) {
            return res.status(404).json({ error: 'Poll not found' });
        }

        if (new Date(polls[0].closes_at) <= new Date()) {
            return res.status(400).json({ error: 'Poll is closed' });
        }

        // The vote must be one of the poll's real options
        if (!parseJSON(polls[0].options).includes(selected_option)) {
            return res.status(400).json({ error: 'Invalid option' });
        }

        // Primary key (poll_id, user_id) makes this atomic; duplicate => already voted
        try {
            await connection.query(
                'INSERT INTO Poll_Votes (poll_id, user_id, selected_option) VALUES (?, ?, ?)',
                [poll_id, user_id, selected_option]
            );
        } catch (err) {
            if (err.code === 'ER_DUP_ENTRY') {
                return res.status(409).json({ error: 'You have already voted' });
            }
            throw err;
        }

        res.status(201).json({ message: 'Vote saved' });
    } finally {
        connection.release();
    }
}));

// ============================================================================
// SOCIETIES ROUTES
// ============================================================================

/**
 * POST /societies
 * Create a new society
 */
app.post('/societies', authenticateToken, asyncHandler(async (req, res) => {
    const name = str(req.body.name);
    const description = str(req.body.description);
    const admin_user_id = req.user.user_id;

    if (!name) {
        return res.status(400).json({ error: 'Society name required' });
    }
    if (name.length > 100) {
        return res.status(400).json({ error: 'Name must be 100 characters or fewer' });
    }

    const connection = await pool.getConnection();
    try {
        const [result] = await connection.query(
            'INSERT INTO Societies (name, description, admin_user_id) VALUES (?, ?, ?)',
            [name, description, admin_user_id]
        );
        // Creator is automatically a member
        await connection.query('INSERT IGNORE INTO Society_Members (society_id, user_id) VALUES (?, ?)', [result.insertId, admin_user_id]);

        res.status(201).json({
            message: 'Society created',
            society_id: result.insertId
        });
    } finally {
        connection.release();
    }
}));

/**
 * GET /societies
 * Get all societies
 */
app.get('/societies', optionalAuth, asyncHandler(async (req, res) => {
    const uid = req.user ? req.user.user_id : 0;
    const connection = await pool.getConnection();
    try {
        const [societies] = await connection.query(`
            SELECT s.*, u.name as admin_name, COUNT(sm.user_id) as member_count,
                   MAX(sm.user_id = ?) AS is_member
            FROM Societies s 
            LEFT JOIN Users u ON s.admin_user_id = u.user_id 
            LEFT JOIN Society_Members sm ON s.society_id = sm.society_id
            GROUP BY s.society_id, u.name
            ORDER BY s.created_at DESC
        `, [uid]);
        societies.forEach(s => { s.is_member = !!s.is_member; });

        res.json({ societies });
    } finally {
        connection.release();
    }
}));

/**
 * POST /societies/:society_id/join
 * Join a society
 */
app.post('/societies/:society_id/join', authenticateToken, asyncHandler(async (req, res) => {
    const { society_id } = req.params;
    const user_id = req.user.user_id;

    const connection = await pool.getConnection();
    try {
        // Check society exists
        const [societies] = await connection.query('SELECT society_id FROM Societies WHERE society_id = ?', [society_id]);
        if (societies.length === 0) {
            return res.status(404).json({ error: 'Society not found' });
        }

        // Insert member
        await connection.query(
            'INSERT IGNORE INTO Society_Members (society_id, user_id) VALUES (?, ?)',
            [society_id, user_id]
        );

        res.json({ message: 'Joined society' });
    } finally {
        connection.release();
    }
}));

/**
 * DELETE /societies/:society_id/leave
 * Leave a society
 */
app.delete('/societies/:society_id/leave', authenticateToken, asyncHandler(async (req, res) => {
    const { society_id } = req.params;
    const user_id = req.user.user_id;

    const connection = await pool.getConnection();
    try {
        await connection.query(
            'DELETE FROM Society_Members WHERE society_id = ? AND user_id = ?',
            [society_id, user_id]
        );

        res.json({ message: 'Left society' });
    } finally {
        connection.release();
    }
}));

/**
 * GET /societies/:society_id/members
 * Get society members (admin only)
 */
app.get('/societies/:society_id/members', authenticateToken, asyncHandler(async (req, res) => {
    const { society_id } = req.params;
    const user_id = req.user.user_id;

    const connection = await pool.getConnection();
    try {
        // Check admin rights
        const [societies] = await connection.query(
            'SELECT admin_user_id FROM Societies WHERE society_id = ?',
            [society_id]
        );

        if (societies.length === 0) {
            return res.status(404).json({ error: 'Society not found' });
        }

        if (societies[0].admin_user_id !== user_id) {
            return res.status(403).json({ error: 'Not authorized' });
        }

        const [members] = await connection.query(
            `SELECT u.user_id, u.name, u.email, sm.joined_at 
             FROM Society_Members sm 
             JOIN Users u ON sm.user_id = u.user_id 
             WHERE sm.society_id = ? 
             ORDER BY sm.joined_at DESC`,
            [society_id]
        );

        res.json({ members });
    } finally {
        connection.release();
    }
}));

// ============================================================================
// TUTORING ROUTES
// ============================================================================

/**
 * POST /tutoring
 * Create a tutoring listing
 */
app.post('/tutoring', authenticateToken, asyncHandler(async (req, res) => {
    const subject = str(req.body.subject);
    const availability = str(req.body.availability);
    const description = str(req.body.description);
    const rate = Number(req.body.rate);
    const tutor_id = req.user.user_id;

    if (!subject || req.body.rate === undefined || req.body.rate === '') {
        return res.status(400).json({ error: 'Subject and rate required' });
    }
    if (subject.length > 100 || availability.length > 200) {
        return res.status(400).json({ error: 'Subject or availability too long' });
    }

    if (!Number.isFinite(rate) || rate <= 0 || rate >= 100000000) {
        return res.status(400).json({ error: 'Rate must be greater than 0' });
    }

    const connection = await pool.getConnection();
    try {
        const [result] = await connection.query(
            'INSERT INTO Tutoring_Listings (tutor_id, subject, rate, availability, description) VALUES (?, ?, ?, ?, ?)',
            [tutor_id, subject, rate, availability, description]
        );

        res.status(201).json({
            message: 'Tutoring listing created',
            tutoring_id: result.insertId
        });
    } finally {
        connection.release();
    }
}));

/**
 * GET /tutoring
 * Get tutoring listings (filter by subject)
 */
app.get('/tutoring', optionalAuth, asyncHandler(async (req, res) => {
    const subject = str(req.query.subject);

    const connection = await pool.getConnection();
    try {
        // Contact email only for logged-in students
        let query = `SELECT t.*, u.name as tutor_name${req.user ? ', u.email as tutor_email' : ''} FROM Tutoring_Listings t JOIN Users u ON t.tutor_id = u.user_id`;
        const params = [];

        if (subject) {
            query += ' WHERE t.subject LIKE ?';
            params.push(`%${subject}%`);
        }

        query += ' ORDER BY t.created_at DESC';

        const [rows] = await connection.query(query, params);
        res.json({ listings: rows.map(t => ({ ...t, rate: Number(t.rate) })) });
    } finally {
        connection.release();
    }
}));

// ============================================================================
// NOTIFICATIONS ROUTES
// ============================================================================

/**
 * GET /notifications
 * Get user notifications
 */
app.get('/notifications', authenticateToken, asyncHandler(async (req, res) => {
    const user_id = req.user.user_id;

    const connection = await pool.getConnection();
    try {
        const [notifications] = await connection.query(
            `SELECT * FROM Notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
            [user_id]
        );

        const [unread] = await connection.query(
            'SELECT COUNT(*) as unread_count FROM Notifications WHERE user_id = ? AND is_read = FALSE',
            [user_id]
        );

        res.json({
            notifications,
            unread_count: unread[0].unread_count
        });
    } finally {
        connection.release();
    }
}));

/**
 * PUT /notifications/:notification_id/read
 * Mark notification as read
 */
app.put('/notifications/:notification_id/read', authenticateToken, asyncHandler(async (req, res) => {
    const { notification_id } = req.params;
    const user_id = req.user.user_id;

    const connection = await pool.getConnection();
    try {
        await connection.query(
            'UPDATE Notifications SET is_read = TRUE WHERE notification_id = ? AND user_id = ?',
            [notification_id, user_id]
        );

        res.json({ message: 'Notification marked as read' });
    } finally {
        connection.release();
    }
}));

/**
 * PUT /notifications/read-all
 * Mark every notification as read
 */
app.put('/notifications/read-all', authenticateToken, asyncHandler(async (req, res) => {
    await pool.query('UPDATE Notifications SET is_read = TRUE WHERE user_id = ?', [req.user.user_id]);
    res.json({ message: 'All notifications marked as read' });
}));

// ============================================================================
// HEALTH CHECK & ERROR HANDLING
// ============================================================================

app.get('/health', (req, res) => {
    res.json({ status: 'Backend healthy', timestamp: new Date().toISOString() });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// Global error handler
app.use((err, req, res, next) => {
    if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'That already exists' });
    }
    if (err.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'Invalid JSON' });
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
});

// ============================================================================
// SERVER START
// ============================================================================

app.listen(PORT, () => {
    console.log(`\n🚀 Campus Connect Backend Running`);
    console.log(`📍 Server: http://localhost:${PORT}`);
    console.log(`🗄️  Database: campus_connect`);
    console.log(`🔐 Authentication: JWT`);
    console.log(`✅ Health Check: GET /health\n`);
});

