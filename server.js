/**
 * Campus Connect - Supabase-ready Express backend
 *
 * Authentication: Supabase Auth
 * Database: Supabase PostgreSQL via @supabase/supabase-js
 * Authorization: PostgreSQL RLS + explicit application checks
 */

import express from 'express';
import { createClient } from '@supabase/supabase-js';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 5000;
const IS_PROD = process.env.NODE_ENV === 'production';
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CAMPUS_EMAIL_DOMAIN = '@mycput.ac.za';
const CAMPUS_EMAIL_REGEX = /^[^\s@]+@mycput\.ac\.za$/i;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('FATAL: SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are required.');
    process.exit(1);
}

const publicClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
});
const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
});

// -----------------------------------------------------------------------------
// Middleware
// -----------------------------------------------------------------------------
app.use(helmet({
    contentSecurityPolicy: {
        useDefaults: true,
        directives: {
            upgradeInsecureRequests: null,
            // Supabase browser client is loaded from jsDelivr in index.html.
            scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'],
            connectSrc: ["'self'", 'https://*.supabase.co', 'https://*.supabase.in']
        }
    }
}));
// In production only the configured frontend may call the API cross-origin
// (same-origin requests are unaffected). Reflecting any origin with credentials is unsafe.
app.use(cors({ origin: process.env.FRONTEND_URL || (IS_PROD ? false : true), credentials: true }));
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const rateBuckets = new Map();
const rateLimit = (max, windowMs) => (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const bucket = (rateBuckets.get(key) || []).filter(t => now - t < windowMs);
    if (bucket.length >= max) return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    bucket.push(now);
    rateBuckets.set(key, bucket);
    next();
};
setInterval(() => rateBuckets.clear(), 60 * 60 * 1000).unref();

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const str = v => typeof v === 'string' ? v.trim() : '';
const toInt = (v, def, min, max) => {
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) return def;
    return Math.min(Math.max(n, min), max);
};
const toIso = v => {
    const s = str(v);
    if (!s) return null;
    const date = new Date(s);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
};
const parseError = (error, fallback = 'Database operation failed') => {
    if (!error) return null;
    if (error.code === '23505') return 'That already exists';
    if (error.code === '23503') return 'Referenced record does not exist';
    if (error.code === '23514') return 'Data failed a database validation rule';
    if (error.message) return error.message;
    return fallback;
};

// Converts a Supabase/PostgREST error into an Error carrying a sensible HTTP status.
const dbError = (error, fallback = 'Database operation failed') => {
    const err = new Error(parseError(error, fallback));
    const code = error?.code;
    if (code === '23505') err.status = 409;
    else if (code === '23503' || code === '23514' || code === '22P02' || code === '23502') err.status = 400;
    else if (code === '42501') { err.status = 403; err.message = 'Not authorized'; }
    return err;
};

function tokenFromRequest(req) {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) return null;
    return header.slice(7).trim() || null;
}

function userClient(token) {
    return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });
}

async function loadUser(token) {
    const { data, error } = await publicClient.auth.getUser(token);
    const user = data?.user;
    if (error || !user) return null;

    const db = userClient(token);
    const { data: profile, error: profileError } = await db
        .from('profiles')
        .select('id,name,email,role,is_active')
        .eq('id', user.id)
        .maybeSingle();
    if (profileError || !profile || !profile.is_active) return null;

    return {
        id: user.id,
        user_id: user.id, // Keep the existing API contract while moving to UUIDs.
        email: user.email,
        name: profile.name,
        role: profile.role,
        profile,
        token,
        db
    };
}

const authenticateToken = asyncHandler(async (req, res, next) => {
    const token = tokenFromRequest(req);
    if (!token) return res.status(401).json({ error: 'Access token required' });
    const user = await loadUser(token);
    if (!user) return res.status(401).json({ error: 'Session expired. Please log in again.' });
    req.user = user;
    next();
});

// Attaches req.user when a valid token is sent; otherwise continues as anonymous.
const optionalAuth = asyncHandler(async (req, res, next) => {
    const token = tokenFromRequest(req);
    if (token) {
        try { req.user = (await loadUser(token)) || undefined; } catch { req.user = undefined; }
    }
    next();
});

async function notifyUsers(rows) {
    if (!rows?.length) return;
    const { error } = await adminClient.from('notifications').insert(rows);
    if (error) console.error('Notification insert failed:', error.message);
}

// Notify every active user (except the author) about new content.
async function broadcast(exceptId, fields) {
    const { data: users, error } = await adminClient.from('profiles').select('id').eq('is_active', true).neq('id', exceptId);
    if (error) { console.error('Broadcast lookup failed:', error.message); return; }
    await notifyUsers((users || []).map(u => ({ user_id: u.id, ...fields, message: String(fields.message).slice(0, 500) })));
}

async function profileMap(client, ids) {
    const queryClient = client === publicClient ? adminClient : client;
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return new Map();
    const { data, error } = await queryClient.from('profiles').select('id,name,email').in('id', unique);
    if (error) throw dbError(error);
    return new Map((data || []).map(p => [p.id, p]));
}

// Public runtime configuration. Contains only the browser-safe anon key.
app.get('/config', (req, res) => {
    res.json({ supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON_KEY });
});

// -----------------------------------------------------------------------------
// Authentication
// -----------------------------------------------------------------------------
app.post('/auth/register', rateLimit(10, 15 * 60 * 1000), asyncHandler(async (req, res) => {
    const name = str(req.body.name);
    const email = str(req.body.email).toLowerCase();
    const student_number = str(req.body.student_number);
    const password = typeof req.body.password === 'string' ? req.body.password : '';

    if (!name || !email || !password || !student_number) return res.status(400).json({ error: 'All fields required' });
    if (name.length > 100 || student_number.length > 20 || email.length > 120) return res.status(400).json({ error: 'One or more fields are too long' });
    if (password.length < 8 || !/\d/.test(password) || !/[a-zA-Z]/.test(password)) return res.status(400).json({ error: 'Password must be at least 8 characters with a letter and number' });
    if (!CAMPUS_EMAIL_REGEX.test(email)) return res.status(400).json({ error: 'Use your CPUT student email address ending in @mycput.ac.za' });

    const { data: existingEmail, error: emailError } = await adminClient.from('profiles').select('id').eq('email', email).limit(1);
    if (emailError) throw dbError(emailError);
    if (existingEmail?.length) return res.status(409).json({ error: 'Email or student number already registered' });
    const { data: existingStudent, error: studentError } = await adminClient.from('profiles').select('id').eq('student_number', student_number).limit(1);
    if (studentError) throw dbError(studentError);
    if (existingStudent?.length) return res.status(409).json({ error: 'Email or student number already registered' });

    const { data, error } = await publicClient.auth.signUp({
        email,
        password,
        options: { data: { name, student_number } }
    });
    if (error) return res.status(400).json({ error: error.message });
    if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
        return res.status(409).json({ error: 'Email or student number already registered' });
    }

    // The database trigger normally creates the profile. The admin upsert makes
    // this endpoint resilient if the trigger was added after an existing Auth user.
    if (data.user) {
        const { error: profileError } = await adminClient.from('profiles').upsert({
            id: data.user.id, name, email, student_number
        }, { onConflict: 'id' });
        if (profileError) throw dbError(profileError);
    }

    if (!data.session) {
        return res.status(202).json({
            message: 'Account created. Check your campus email to confirm your account, then log in.',
            requires_email_confirmation: true
        });
    }

    const profile = await getProfile(adminClient, data.user.id);
    res.status(201).json({
        message: 'Account created successfully',
        token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at,
        user: toApiUser(profile)
    });
}));

app.post('/auth/login', rateLimit(20, 15 * 60 * 1000), asyncHandler(async (req, res) => {
    const email = str(req.body.email).toLowerCase();
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (!CAMPUS_EMAIL_REGEX.test(email)) return res.status(400).json({ error: 'Use your CPUT student email address ending in @mycput.ac.za' });

    const { data, error } = await publicClient.auth.signInWithPassword({ email, password });
    if (error || !data.session || !data.user) return res.status(401).json({ error: 'Invalid credentials' });

    const profile = await getProfile(adminClient, data.user.id);
    if (!profile || !profile.is_active) return res.status(401).json({ error: 'Account is inactive' });

    res.json({
        message: 'Login successful',
        token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at,
        user: toApiUser(profile)
    });
}));

app.post('/auth/forgot-password', rateLimit(5, 15 * 60 * 1000), asyncHandler(async (req, res) => {
    const email = str(req.body.email).toLowerCase();
    const student_number = str(req.body.student_number);
    if (!email || !student_number) return res.status(400).json({ error: 'Email and student number required' });
    if (!CAMPUS_EMAIL_REGEX.test(email)) return res.status(400).json({ error: 'Use your CPUT student email address ending in @mycput.ac.za' });

    const { data: profiles } = await adminClient.from('profiles')
        .select('id,email,student_number').eq('email', email).eq('student_number', student_number).limit(1);

    if (profiles?.length) {
        const redirectTo = process.env.PASSWORD_RESET_REDIRECT_URL || `${process.env.FRONTEND_URL || `http://localhost:${PORT}`}/`;
        const { error } = await publicClient.auth.resetPasswordForEmail(email, { redirectTo });
        if (error) console.error('Password reset request failed:', error.message);
    }

    // Keep the response intentionally generic to avoid account enumeration.
    res.json({ message: 'If those details match an account, a password reset email has been sent.' });
}));

app.post('/auth/reset-password', rateLimit(10, 15 * 60 * 1000), asyncHandler(async (req, res) => {
    const new_password = typeof req.body.new_password === 'string' ? req.body.new_password : '';
    const access_token = str(req.body.access_token);
    if (!access_token || !new_password) return res.status(400).json({ error: 'Recovery session and password required' });
    if (new_password.length < 8 || !/\d/.test(new_password) || !/[a-zA-Z]/.test(new_password)) {
        return res.status(400).json({ error: 'Password must be at least 8 characters with a letter and number' });
    }

    // A per-request client has no stored session, so auth.updateUser() would fail with
    // "Auth session missing". Verify the recovery token, then update via the admin API.
    const { data: recovery, error: recoveryError } = await publicClient.auth.getUser(access_token);
    if (recoveryError || !recovery?.user) return res.status(400).json({ error: 'Recovery link is invalid or has expired' });
    const { error } = await adminClient.auth.admin.updateUserById(recovery.user.id, { password: new_password });
    if (error) return res.status(400).json({ error: error.message });
    res.json({ message: 'Password reset successfully' });
}));

app.get('/auth/me', authenticateToken, asyncHandler(async (req, res) => {
    res.json({ user: toApiUser(req.user.profile) });
}));

app.post('/auth/logout', authenticateToken, asyncHandler(async (req, res) => {
    // The browser owns the session. signOut is best-effort; clearing the local
    // session on the client is still required and is handled by Supabase Auth.
    await adminClient.auth.admin.signOut(req.user.token).catch(() => {});
    res.json({ message: 'Logged out' });
}));

function toApiUser(profile) {
    if (!profile) return null;
    return { user_id: profile.id, name: profile.name, email: profile.email, role: profile.role };
}

async function getProfile(client, id) {
    const { data, error } = await client.from('profiles').select('id,name,email,student_number,role,is_active').eq('id', id).maybeSingle();
    if (error) throw dbError(error);
    return data;
}

// -----------------------------------------------------------------------------
// Marketplace
// -----------------------------------------------------------------------------
const LISTING_STATUSES = ['Available', 'Pending', 'Sold'];

app.post('/listings', authenticateToken, asyncHandler(async (req, res) => {
    const title = str(req.body.title), description = str(req.body.description);
    const price = Number(req.body.price);
    const status = LISTING_STATUSES.includes(req.body.status) ? req.body.status : 'Available';
    if (!title || req.body.price === undefined || req.body.price === '') return res.status(400).json({ error: 'Title and price required' });
    if (title.length > 150) return res.status(400).json({ error: 'Title must be 150 characters or fewer' });
    if (!Number.isFinite(price) || price <= 0 || price >= 100000000) return res.status(400).json({ error: 'Price must be greater than 0' });

    const { data, error } = await req.user.db.from('listings')
        .insert({ user_id: req.user.id, title, description, price, status }).select('listing_id').single();
    if (error) throw dbError(error);
    await broadcast(req.user.id, { type: 'Listing', message: `New listing: ${title} (R${price.toFixed(2)})`, related_listing_id: data.listing_id });
    res.status(201).json({ message: 'Listing created', listing_id: data.listing_id });
}));

app.get('/listings', optionalAuth, asyncHandler(async (req, res) => {
    const client = req.user?.db || publicClient;
    const status = LISTING_STATUSES.includes(req.query.status) ? req.query.status : null;
    // Strip characters that have meaning inside a PostgREST .or() filter string.
    const search = str(req.query.search).replace(/[,()*\\]/g, ' ').trim();
    const page = toInt(req.query.page, 1, 1, 100000), limit = toInt(req.query.limit, 20, 1, 100);
    let q = client.from('listings').select('*').order('created_at', { ascending: false }).range((page - 1) * limit, page * limit - 1);
    if (status) q = q.eq('status', status);
    if (search) q = q.or(`title.ilike.%${search}%,description.ilike.%${search}%`);
    const { data, error } = await q;
    if (error) throw dbError(error);
    const profiles = await profileMap(client, (data || []).map(x => x.user_id));
    const listings = (data || []).map(l => ({ ...l, price: Number(l.price), seller_name: profiles.get(l.user_id)?.name || 'Unknown' }));
    res.json({ listings, pagination: { page, limit } });
}));

app.get('/listings/:listing_id', optionalAuth, asyncHandler(async (req, res) => {
    const client = req.user?.db || publicClient;
    const { data: listing, error } = await client.from('listings').select('*').eq('listing_id', req.params.listing_id).maybeSingle();
    if (error) throw dbError(error);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    const profiles = await profileMap(client, [listing.user_id]);
    const seller = profiles.get(listing.user_id);
    const is_owner = !!req.user && req.user.id === listing.user_id;
    const result = { ...listing, price: Number(listing.price), seller_name: seller?.name || 'Unknown' };
    if (req.user) result.seller_email = seller?.email;

    let responses = [];
    if (is_owner) {
        const { data, error: responseError } = await client.from('listing_responses').select('*').eq('listing_id', req.params.listing_id).order('created_at', { ascending: false });
        if (responseError) throw dbError(responseError);
        const responderProfiles = await profileMap(client, (data || []).map(x => x.responder_id));
        responses = (data || []).map(r => ({ ...r, responder_name: responderProfiles.get(r.responder_id)?.name || 'Unknown', responder_email: responderProfiles.get(r.responder_id)?.email || null }));
    }
    res.json({ listing: result, responses, is_owner });
}));

app.put('/listings/:listing_id', authenticateToken, asyncHandler(async (req, res) => {
    const { data: listing, error: findError } = await req.user.db.from('listings').select('user_id').eq('listing_id', req.params.listing_id).maybeSingle();
    if (findError) throw dbError(findError);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    if (listing.user_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });

    const update = {};
    if (req.body.title !== undefined) {
        const title = str(req.body.title);
        if (!title || title.length > 150) return res.status(400).json({ error: 'Invalid title' });
        update.title = title;
    }
    if (req.body.description !== undefined) update.description = str(req.body.description);
    if (req.body.price !== undefined) {
        const price = Number(req.body.price);
        if (!Number.isFinite(price) || price <= 0 || price >= 100000000) return res.status(400).json({ error: 'Price must be greater than 0' });
        update.price = price;
    }
    if (req.body.status !== undefined) {
        if (!LISTING_STATUSES.includes(req.body.status)) return res.status(400).json({ error: 'Invalid status' });
        update.status = req.body.status;
    }
    if (!Object.keys(update).length) return res.status(400).json({ error: 'Nothing to update' });
    const { error } = await req.user.db.from('listings').update(update).eq('listing_id', req.params.listing_id).eq('user_id', req.user.id);
    if (error) throw dbError(error);
    res.json({ message: 'Listing updated' });
}));

app.delete('/listings/:listing_id', authenticateToken, asyncHandler(async (req, res) => {
    const { data: listing, error } = await req.user.db.from('listings').select('user_id').eq('listing_id', req.params.listing_id).maybeSingle();
    if (error) throw dbError(error);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    if (listing.user_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
    const { error: deleteError } = await req.user.db.from('listings').delete().eq('listing_id', req.params.listing_id).eq('user_id', req.user.id);
    if (deleteError) throw dbError(deleteError);
    res.json({ message: 'Listing deleted' });
}));

app.post('/listings/:listing_id/responses', authenticateToken, asyncHandler(async (req, res) => {
    const message = str(req.body.message);
    if (message.length < 1 || message.length > 500) return res.status(400).json({ error: 'Message must be 1-500 characters' });
    const { data: listing, error: findError } = await req.user.db.from('listings').select('user_id,title').eq('listing_id', req.params.listing_id).maybeSingle();
    if (findError) throw dbError(findError);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    if (listing.user_id === req.user.id) return res.status(400).json({ error: "You can't respond to your own listing" });

    const { data, error } = await req.user.db.from('listing_responses').insert({ listing_id: req.params.listing_id, responder_id: req.user.id, message }).select('response_id').single();
    if (error) throw dbError(error);
    await notifyUsers([{ user_id: listing.user_id, type: 'Listing', message: `${req.user.email} responded to your listing`, related_listing_id: req.params.listing_id }]);
    res.status(201).json({ message: 'Response saved', response_id: data.response_id });
}));

// -----------------------------------------------------------------------------
// Events
// -----------------------------------------------------------------------------
app.post('/events', authenticateToken, asyncHandler(async (req, res) => {
    const title = str(req.body.title), description = str(req.body.description), location = str(req.body.location);
    const date_time = toIso(req.body.date_time);
    if (!title || !date_time) return res.status(400).json({ error: 'Title and date_time required' });
    if (title.length > 150 || location.length > 200) return res.status(400).json({ error: 'Title or location too long' });

    const { data, error } = await req.user.db.from('events').insert({ organiser_id: req.user.id, title, description, location, date_time }).select('event_id').single();
    if (error) throw dbError(error);

    await broadcast(req.user.id, { type: 'Event', message: `New event: ${title}`, related_event_id: data.event_id });
    res.status(201).json({ message: 'Event created', event_id: data.event_id });
}));

app.get('/events', optionalAuth, asyncHandler(async (req, res) => {
    const client = req.user?.db || publicClient;
    const page = toInt(req.query.page, 1, 1, 100000), limit = toInt(req.query.limit, 50, 1, 100);
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: events, error } = await client.from('events').select('*').gte('date_time', cutoff).order('date_time', { ascending: true }).range((page - 1) * limit, page * limit - 1);
    if (error) throw dbError(error);
    const profiles = await profileMap(client, (events || []).map(e => e.organiser_id));
    let rsvps = [];
    if (req.user && events?.length) {
        const { data, error: rsvpError } = await client.from('event_rsvps').select('event_id,rsvp_status').eq('user_id', req.user.id).in('event_id', events.map(e => e.event_id));
        if (rsvpError) throw dbError(rsvpError);
        rsvps = data || [];
    }
    const rsvpMap = new Map(rsvps.map(r => [r.event_id, r.rsvp_status]));
    let attendance = [];
    if (events?.length) {
        const { data, error: attendanceError } = await client.from('vw_event_attendance').select('*').in('event_id', events.map(e => e.event_id));
        if (!attendanceError) attendance = data || [];
    }
    const attendanceMap = new Map(attendance.map(a => [a.event_id, a]));
    const result = (events || []).map(e => {
        const a = attendanceMap.get(e.event_id) || {};
        return { ...e, organiser_name: profiles.get(e.organiser_id)?.name || 'Unknown', attending_count: Number(a.attending_count || 0), interested_count: Number(a.interested_count || 0), my_rsvp: rsvpMap.get(e.event_id) || null };
    });
    res.json({ events: result, pagination: { page, limit } });
}));

app.post('/events/:event_id/rsvp', authenticateToken, asyncHandler(async (req, res) => {
    const validStatuses = ['Attending', 'Not_Attending', 'Interested'];
    if (!validStatuses.includes(req.body.rsvp_status)) return res.status(400).json({ error: 'Invalid RSVP status' });
    const { data: event, error: findError } = await req.user.db.from('events').select('event_id,organiser_id,title').eq('event_id', req.params.event_id).maybeSingle();
    if (findError) throw dbError(findError);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const { error } = await req.user.db.from('event_rsvps').upsert({ event_id: req.params.event_id, user_id: req.user.id, rsvp_status: req.body.rsvp_status }, { onConflict: 'event_id,user_id' });
    if (error) throw dbError(error);
    if (req.body.rsvp_status === 'Attending' && event.organiser_id !== req.user.id) await notifyUsers([{ user_id: event.organiser_id, type: 'Event', message: `${req.user.name} is attending ${event.title}`, related_event_id: event.event_id }]);
    res.json({ message: 'RSVP saved' });
}));

// -----------------------------------------------------------------------------
// Polls
// -----------------------------------------------------------------------------
app.post('/polls', authenticateToken, asyncHandler(async (req, res) => {
    const question = str(req.body.question);
    const options = Array.isArray(req.body.options) ? [...new Set(req.body.options.map(str).filter(Boolean))] : [];
    const closes_at = toIso(req.body.closes_at);
    if (!question || options.length < 2) return res.status(400).json({ error: 'Question and at least 2 different options required' });
    if (question.length > 255 || options.length > 10 || options.some(o => o.length > 255)) return res.status(400).json({ error: 'Question or options too long' });
    if (!closes_at || new Date(closes_at) <= new Date()) return res.status(400).json({ error: 'Closing time must be in the future' });
    const { data, error } = await req.user.db.from('polls').insert({ created_by: req.user.id, question, options, closes_at }).select('poll_id').single();
    if (error) throw dbError(error);
    await broadcast(req.user.id, { type: 'Poll', message: `New poll: ${question}`, related_poll_id: data.poll_id });
    res.status(201).json({ message: 'Poll created', poll_id: data.poll_id });
}));

app.get('/polls', optionalAuth, asyncHandler(async (req, res) => {
    const client = req.user?.db || publicClient;
    const { data: polls, error } = await client.from('polls').select('*').gt('closes_at', new Date(Date.now() - 7 * 86400000).toISOString()).order('closes_at', { ascending: true });
    if (error) throw dbError(error);
    const rows = polls || [];
    const profiles = await profileMap(client, rows.map(p => p.created_by));
    let votes = [];
    if (req.user) {
        const { data, error: votesError } = await client.from('poll_votes').select('poll_id,user_id,selected_option').eq('user_id', req.user.id);
        if (votesError) throw dbError(votesError);
        votes = data || [];
    }
    const myVotes = new Map(votes.map(v => [v.poll_id, v.selected_option]));

    // Vote counts/results are intentionally calculated server-side with service_role
    // so users do not need broad read access to other users' votes.
    const pollIds = rows.map(p => p.poll_id);
    let allVotes = [], allVotesError = null;
    if (pollIds.length) ({ data: allVotes, error: allVotesError } = await adminClient.from('poll_votes').select('poll_id,selected_option').in('poll_id', pollIds));
    if (allVotesError) throw dbError(allVotesError);
    const result = rows.map(p => {
        const my_vote = myVotes.get(p.poll_id) || null;
        const is_active = new Date(p.closes_at) > new Date();
        const tally = {};
        for (const o of (Array.isArray(p.options) ? p.options : [])) tally[o] = 0;
        for (const v of (allVotes || []).filter(v => v.poll_id === p.poll_id)) tally[v.selected_option] = (tally[v.selected_option] || 0) + 1;
        const vote_count = Object.values(tally).reduce((a, b) => a + b, 0);
        const out = { ...p, creator_name: profiles.get(p.created_by)?.name || 'Unknown', vote_count, my_vote, is_active };
        if (my_vote || !is_active) out.results = tally;
        return out;
    });
    result.sort((a, b) => Number(b.is_active) - Number(a.is_active) || new Date(a.closes_at) - new Date(b.closes_at));
    res.json({ polls: result });
}));

app.post('/polls/:poll_id/vote', authenticateToken, asyncHandler(async (req, res) => {
    const selected_option = str(req.body.selected_option);
    if (!selected_option) return res.status(400).json({ error: 'Selected option required' });
    const { data: poll, error: findError } = await req.user.db.from('polls').select('closes_at,options').eq('poll_id', req.params.poll_id).maybeSingle();
    if (findError) throw dbError(findError);
    if (!poll) return res.status(404).json({ error: 'Poll not found' });
    if (new Date(poll.closes_at) <= new Date()) return res.status(400).json({ error: 'Poll is closed' });
    if (!Array.isArray(poll.options) || !poll.options.includes(selected_option)) return res.status(400).json({ error: 'Invalid option' });
    const { error } = await req.user.db.from('poll_votes').insert({ poll_id: req.params.poll_id, user_id: req.user.id, selected_option });
    if (error?.code === '23505') return res.status(409).json({ error: 'You have already voted' });
    if (error) throw dbError(error);
    res.status(201).json({ message: 'Vote saved' });
}));

// -----------------------------------------------------------------------------
// Societies
// -----------------------------------------------------------------------------
app.post('/societies', authenticateToken, asyncHandler(async (req, res) => {
    const name = str(req.body.name), description = str(req.body.description);
    if (!name) return res.status(400).json({ error: 'Society name required' });
    if (name.length > 100) return res.status(400).json({ error: 'Name must be 100 characters or fewer' });
    const { data, error } = await req.user.db.from('societies').insert({ name, description, admin_user_id: req.user.id }).select('society_id').single();
    if (error) throw dbError(error);
    const { error: memberError } = await req.user.db.from('society_members').upsert({ society_id: data.society_id, user_id: req.user.id }, { onConflict: 'society_id,user_id' });
    if (memberError) throw dbError(memberError);
    await broadcast(req.user.id, { type: 'Society', message: `New society: ${name}` });
    res.status(201).json({ message: 'Society created', society_id: data.society_id });
}));

app.get('/societies', optionalAuth, asyncHandler(async (req, res) => {
    const client = req.user?.db || publicClient;
    const { data: societies, error } = await client.from('societies').select('*').order('created_at', { ascending: false });
    if (error) throw dbError(error);
    const rows = societies || [];
    const admins = await profileMap(client, rows.map(s => s.admin_user_id));
    const membershipClient = adminClient;
    const { data: members, error: memberError } = rows.length
        ? await membershipClient.from('society_members').select('society_id,user_id').in('society_id', rows.map(s => s.society_id))
        : { data: [], error: null };
    if (memberError) throw dbError(memberError);
    const counts = new Map(), mine = new Set();
    for (const m of members || []) {
        counts.set(m.society_id, (counts.get(m.society_id) || 0) + 1);
        if (req.user && m.user_id === req.user.id) mine.add(m.society_id);
    }
    res.json({ societies: rows.map(s => ({ ...s, admin_name: admins.get(s.admin_user_id)?.name || null, member_count: counts.get(s.society_id) || 0, is_member: mine.has(s.society_id) })) });
}));

app.post('/societies/:society_id/join', authenticateToken, asyncHandler(async (req, res) => {
    const { data: society, error } = await req.user.db.from('societies').select('society_id').eq('society_id', req.params.society_id).maybeSingle();
    if (error) throw dbError(error);
    if (!society) return res.status(404).json({ error: 'Society not found' });
    const { error: insertError } = await req.user.db.from('society_members').upsert({ society_id: req.params.society_id, user_id: req.user.id }, { onConflict: 'society_id,user_id', ignoreDuplicates: true });
    if (insertError) throw dbError(insertError);
    const { data: soc } = await adminClient.from('societies').select('name,admin_user_id').eq('society_id', req.params.society_id).maybeSingle();
    if (soc?.admin_user_id && soc.admin_user_id !== req.user.id) await notifyUsers([{ user_id: soc.admin_user_id, type: 'Society', message: `${req.user.name} joined ${soc.name}` }]);
    res.json({ message: 'Joined society' });
}));

app.delete('/societies/:society_id/leave', authenticateToken, asyncHandler(async (req, res) => {
    const { error } = await req.user.db.from('society_members').delete().eq('society_id', req.params.society_id).eq('user_id', req.user.id);
    if (error) throw dbError(error);
    res.json({ message: 'Left society' });
}));

app.get('/societies/:society_id/members', authenticateToken, asyncHandler(async (req, res) => {
    const { data: society, error } = await req.user.db.from('societies').select('admin_user_id').eq('society_id', req.params.society_id).maybeSingle();
    if (error) throw dbError(error);
    if (!society) return res.status(404).json({ error: 'Society not found' });
    if (society.admin_user_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
    const { data: members, error: memberError } = await req.user.db.from('society_members').select('user_id,joined_at').eq('society_id', req.params.society_id).order('joined_at', { ascending: false });
    if (memberError) throw dbError(memberError);
    const profiles = await profileMap(req.user.db, (members || []).map(m => m.user_id));
    res.json({ members: (members || []).map(m => ({ user_id: m.user_id, name: profiles.get(m.user_id)?.name, email: profiles.get(m.user_id)?.email, joined_at: m.joined_at })) });
}));

// -----------------------------------------------------------------------------
// Tutoring
// -----------------------------------------------------------------------------
app.post('/tutoring', authenticateToken, asyncHandler(async (req, res) => {
    const subject = str(req.body.subject), availability = str(req.body.availability), description = str(req.body.description);
    const rate = Number(req.body.rate);
    if (!subject || req.body.rate === undefined || req.body.rate === '') return res.status(400).json({ error: 'Subject and rate required' });
    if (subject.length > 100 || availability.length > 200) return res.status(400).json({ error: 'Subject or availability too long' });
    if (!Number.isFinite(rate) || rate <= 0 || rate >= 100000000) return res.status(400).json({ error: 'Rate must be greater than 0' });
    const { data, error } = await req.user.db.from('tutoring_listings').insert({ tutor_id: req.user.id, subject, rate, availability, description }).select('tutoring_id').single();
    if (error) throw dbError(error);
    await broadcast(req.user.id, { type: 'System', message: `New tutoring offer: ${subject} (R${rate.toFixed(2)}/hr)` });
    res.status(201).json({ message: 'Tutoring listing created', tutoring_id: data.tutoring_id });
}));

app.get('/tutoring', optionalAuth, asyncHandler(async (req, res) => {
    const client = req.user?.db || publicClient;
    const subject = str(req.query.subject);
    let q = client.from('tutoring_listings').select('*').order('created_at', { ascending: false });
    if (subject) q = q.ilike('subject', `%${subject}%`);
    const { data, error } = await q;
    if (error) throw dbError(error);
    const profiles = await profileMap(client, (data || []).map(t => t.tutor_id));
    res.json({ listings: (data || []).map(t => ({ ...t, rate: Number(t.rate), tutor_name: profiles.get(t.tutor_id)?.name || 'Unknown', ...(req.user ? { tutor_email: profiles.get(t.tutor_id)?.email || null } : {}) })) });
}));

// -----------------------------------------------------------------------------
// Notifications
// -----------------------------------------------------------------------------
app.get('/notifications', authenticateToken, asyncHandler(async (req, res) => {
    const { data: notifications, error } = await req.user.db.from('notifications').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(50);
    if (error) throw dbError(error);
    const { count, error: countError } = await req.user.db.from('notifications').select('notification_id', { count: 'exact', head: true }).eq('user_id', req.user.id).eq('is_read', false);
    if (countError) throw dbError(countError);
    res.json({ notifications: notifications || [], unread_count: count || 0 });
}));

app.put('/notifications/:notification_id/read', authenticateToken, asyncHandler(async (req, res) => {
    const { error } = await req.user.db.from('notifications').update({ is_read: true }).eq('notification_id', req.params.notification_id).eq('user_id', req.user.id);
    if (error) throw dbError(error);
    res.json({ message: 'Notification marked as read' });
}));

app.put('/notifications/read-all', authenticateToken, asyncHandler(async (req, res) => {
    const { error } = await req.user.db.from('notifications').update({ is_read: true }).eq('user_id', req.user.id);
    if (error) throw dbError(error);
    res.json({ message: 'All notifications marked as read' });
}));

// -----------------------------------------------------------------------------
// Edit / delete for events, polls, societies and tutoring (owner only)
// -----------------------------------------------------------------------------
// Loads a row through the caller's RLS-scoped client and verifies ownership.
async function loadOwned(req, res, table, idCol, ownerCol, cols) {
    const { data, error } = await req.user.db.from(table).select(`${idCol},${ownerCol},${cols}`).eq(idCol, req.params.id).maybeSingle();
    if (error) throw dbError(error);
    if (!data) { res.status(404).json({ error: 'Not found' }); return null; }
    if (data[ownerCol] !== req.user.id) { res.status(403).json({ error: 'Not authorized' }); return null; }
    return data;
}

app.put('/events/:id', authenticateToken, asyncHandler(async (req, res) => {
    const ev = await loadOwned(req, res, 'events', 'event_id', 'organiser_id', 'title'); if (!ev) return;
    const update = {};
    if (req.body.title !== undefined) { const t = str(req.body.title); if (!t || t.length > 150) return res.status(400).json({ error: 'Invalid title' }); update.title = t; }
    if (req.body.description !== undefined) update.description = str(req.body.description);
    if (req.body.location !== undefined) { const l = str(req.body.location); if (l.length > 200) return res.status(400).json({ error: 'Location too long' }); update.location = l; }
    if (req.body.date_time !== undefined) { const d = toIso(req.body.date_time); if (!d) return res.status(400).json({ error: 'Invalid date' }); update.date_time = d; }
    if (!Object.keys(update).length) return res.status(400).json({ error: 'Nothing to update' });
    const { error } = await req.user.db.from('events').update(update).eq('event_id', ev.event_id).eq('organiser_id', req.user.id);
    if (error) throw dbError(error);
    const { data: rsvps } = await adminClient.from('event_rsvps').select('user_id').eq('event_id', ev.event_id).neq('rsvp_status', 'Not_Attending').neq('user_id', req.user.id);
    await notifyUsers((rsvps || []).map(r => ({ user_id: r.user_id, type: 'Event', message: `Event updated: ${update.title || ev.title}`, related_event_id: ev.event_id })));
    res.json({ message: 'Event updated' });
}));

app.delete('/events/:id', authenticateToken, asyncHandler(async (req, res) => {
    const ev = await loadOwned(req, res, 'events', 'event_id', 'organiser_id', 'title'); if (!ev) return;
    const { data: rsvps } = await adminClient.from('event_rsvps').select('user_id').eq('event_id', ev.event_id).neq('rsvp_status', 'Not_Attending').neq('user_id', req.user.id);
    const { error } = await req.user.db.from('events').delete().eq('event_id', ev.event_id).eq('organiser_id', req.user.id);
    if (error) throw dbError(error);
    await notifyUsers((rsvps || []).map(r => ({ user_id: r.user_id, type: 'Event', message: `Event cancelled: ${ev.title}` })));
    res.json({ message: 'Event deleted' });
}));

app.get('/events/:id/attendees', authenticateToken, asyncHandler(async (req, res) => {
    const ev = await loadOwned(req, res, 'events', 'event_id', 'organiser_id', 'title'); if (!ev) return;
    const { data, error } = await adminClient.from('event_rsvps').select('user_id,rsvp_status,updated_at').eq('event_id', ev.event_id).neq('rsvp_status', 'Not_Attending');
    if (error) throw dbError(error);
    const profiles = await profileMap(adminClient, (data || []).map(r => r.user_id));
    res.json({ attendees: (data || []).map(r => ({ user_id: r.user_id, name: profiles.get(r.user_id)?.name || 'Unknown', rsvp_status: r.rsvp_status })) });
}));

app.put('/polls/:id', authenticateToken, asyncHandler(async (req, res) => {
    const poll = await loadOwned(req, res, 'polls', 'poll_id', 'created_by', 'question'); if (!poll) return;
    const update = {};
    if (req.body.question !== undefined) { const q = str(req.body.question); if (!q || q.length > 255) return res.status(400).json({ error: 'Invalid question' }); update.question = q; }
    if (req.body.closes_at !== undefined) { const c = toIso(req.body.closes_at); if (!c) return res.status(400).json({ error: 'Invalid closing time' }); update.closes_at = c; }
    if (req.body.options !== undefined) {
        const options = Array.isArray(req.body.options) ? [...new Set(req.body.options.map(str).filter(Boolean))] : [];
        if (options.length < 2 || options.length > 10 || options.some(o => o.length > 255)) return res.status(400).json({ error: 'At least 2 different options required' });
        const { data: current } = await adminClient.from('polls').select('options').eq('poll_id', poll.poll_id).maybeSingle();
        const changed = JSON.stringify(current?.options) !== JSON.stringify(options);
        if (changed) {
            const { count, error: cErr } = await adminClient.from('poll_votes').select('poll_id', { count: 'exact', head: true }).eq('poll_id', poll.poll_id);
            if (cErr) throw dbError(cErr);
            if (count > 0) return res.status(409).json({ error: 'Options can’t be changed after people have voted. You can still edit the question or closing time.' });
            update.options = options;
        }
    }
    if (!Object.keys(update).length) return res.status(400).json({ error: 'Nothing to update' });
    const { error } = await req.user.db.from('polls').update(update).eq('poll_id', poll.poll_id).eq('created_by', req.user.id);
    if (error) throw dbError(error);
    res.json({ message: 'Poll updated' });
}));

app.delete('/polls/:id', authenticateToken, asyncHandler(async (req, res) => {
    const poll = await loadOwned(req, res, 'polls', 'poll_id', 'created_by', 'question'); if (!poll) return;
    const { error } = await req.user.db.from('polls').delete().eq('poll_id', poll.poll_id).eq('created_by', req.user.id);
    if (error) throw dbError(error);
    res.json({ message: 'Poll deleted' });
}));

app.put('/tutoring/:id', authenticateToken, asyncHandler(async (req, res) => {
    const t = await loadOwned(req, res, 'tutoring_listings', 'tutoring_id', 'tutor_id', 'subject'); if (!t) return;
    const update = {};
    if (req.body.subject !== undefined) { const v = str(req.body.subject); if (!v || v.length > 100) return res.status(400).json({ error: 'Invalid subject' }); update.subject = v; }
    if (req.body.rate !== undefined) { const r = Number(req.body.rate); if (!Number.isFinite(r) || r <= 0 || r >= 100000000) return res.status(400).json({ error: 'Rate must be greater than 0' }); update.rate = r; }
    if (req.body.availability !== undefined) { const a = str(req.body.availability); if (a.length > 200) return res.status(400).json({ error: 'Availability too long' }); update.availability = a; }
    if (req.body.description !== undefined) update.description = str(req.body.description);
    if (!Object.keys(update).length) return res.status(400).json({ error: 'Nothing to update' });
    const { error } = await req.user.db.from('tutoring_listings').update(update).eq('tutoring_id', t.tutoring_id).eq('tutor_id', req.user.id);
    if (error) throw dbError(error);
    res.json({ message: 'Tutoring listing updated' });
}));

app.delete('/tutoring/:id', authenticateToken, asyncHandler(async (req, res) => {
    const t = await loadOwned(req, res, 'tutoring_listings', 'tutoring_id', 'tutor_id', 'subject'); if (!t) return;
    const { error } = await req.user.db.from('tutoring_listings').delete().eq('tutoring_id', t.tutoring_id).eq('tutor_id', req.user.id);
    if (error) throw dbError(error);
    res.json({ message: 'Tutoring listing deleted' });
}));

app.put('/societies/:id', authenticateToken, asyncHandler(async (req, res) => {
    const s = await loadOwned(req, res, 'societies', 'society_id', 'admin_user_id', 'name'); if (!s) return;
    const update = {};
    if (req.body.name !== undefined) { const n = str(req.body.name); if (!n || n.length > 100) return res.status(400).json({ error: 'Invalid name' }); update.name = n; }
    if (req.body.description !== undefined) update.description = str(req.body.description);
    if (!Object.keys(update).length) return res.status(400).json({ error: 'Nothing to update' });
    const { error } = await req.user.db.from('societies').update(update).eq('society_id', s.society_id).eq('admin_user_id', req.user.id);
    if (error) throw dbError(error);
    res.json({ message: 'Society updated' });
}));

app.delete('/societies/:id', authenticateToken, asyncHandler(async (req, res) => {
    const s = await loadOwned(req, res, 'societies', 'society_id', 'admin_user_id', 'name'); if (!s) return;
    const { error } = await req.user.db.from('societies').delete().eq('society_id', s.society_id).eq('admin_user_id', req.user.id);
    if (error) throw dbError(error);
    res.json({ message: 'Society deleted' });
}));

// -----------------------------------------------------------------------------
// Profiles & "my activity"
// -----------------------------------------------------------------------------
app.get('/users/:id', authenticateToken, asyncHandler(async (req, res) => {
    const id = req.params.id, db = req.user.db;
    const { data: profile, error } = await db.from('profiles').select('id,name,role,created_at').eq('id', id).maybeSingle();
    if (error) throw dbError(error);
    if (!profile) return res.status(404).json({ error: 'User not found' });
    const [listings, tutoring, events, societies, polls] = await Promise.all([
        db.from('listings').select('listing_id,title,price,status,created_at').eq('user_id', id).order('created_at', { ascending: false }).limit(20),
        db.from('tutoring_listings').select('tutoring_id,subject,rate,availability').eq('tutor_id', id).order('created_at', { ascending: false }).limit(20),
        db.from('events').select('event_id,title,date_time,location').eq('organiser_id', id).gte('date_time', new Date().toISOString()).order('date_time').limit(20),
        db.from('societies').select('society_id,name').eq('admin_user_id', id).limit(20),
        db.from('polls').select('poll_id,question,closes_at').eq('created_by', id).order('created_at', { ascending: false }).limit(10)
    ]);
    for (const r of [listings, tutoring, events, societies, polls]) if (r.error) throw dbError(r.error);
    res.json({
        user: { user_id: profile.id, name: profile.name, role: profile.role, member_since: profile.created_at, is_me: profile.id === req.user.id },
        listings: (listings.data || []).map(l => ({ ...l, price: Number(l.price) })),
        tutoring: (tutoring.data || []).map(t => ({ ...t, rate: Number(t.rate) })),
        events: events.data || [], societies: societies.data || [], polls: polls.data || []
    });
}));

app.get('/me/activity', authenticateToken, asyncHandler(async (req, res) => {
    const db = req.user.db, id = req.user.id;
    const [listings, tutoring, events, societies, polls, rsvps, memberships] = await Promise.all([
        db.from('listings').select('*').eq('user_id', id).order('created_at', { ascending: false }),
        db.from('tutoring_listings').select('*').eq('tutor_id', id).order('created_at', { ascending: false }),
        db.from('events').select('*').eq('organiser_id', id).order('date_time', { ascending: false }),
        db.from('societies').select('*').eq('admin_user_id', id),
        db.from('polls').select('*').eq('created_by', id).order('created_at', { ascending: false }),
        db.from('event_rsvps').select('event_id,rsvp_status').eq('user_id', id).neq('rsvp_status', 'Not_Attending'),
        db.from('society_members').select('society_id').eq('user_id', id)
    ]);
    for (const r of [listings, tutoring, events, societies, polls, rsvps, memberships]) if (r.error) throw dbError(r.error);
    const eventIds = (rsvps.data || []).map(r => r.event_id), socIds = (memberships.data || []).map(m => m.society_id);
    const [goingEvents, joinedSocieties] = await Promise.all([
        eventIds.length ? db.from('events').select('event_id,title,date_time,location').in('event_id', eventIds).order('date_time') : { data: [] },
        socIds.length ? db.from('societies').select('society_id,name').in('society_id', socIds) : { data: [] }
    ]);
    const status = new Map((rsvps.data || []).map(r => [r.event_id, r.rsvp_status]));
    res.json({
        listings: (listings.data || []).map(l => ({ ...l, price: Number(l.price) })),
        tutoring: (tutoring.data || []).map(t => ({ ...t, rate: Number(t.rate) })),
        events: events.data || [], societies: societies.data || [], polls: polls.data || [],
        going: (goingEvents.data || []).map(e => ({ ...e, my_rsvp: status.get(e.event_id) })),
        joined_societies: (joinedSocieties.data || []).filter(s => !(societies.data || []).some(a => a.society_id === s.society_id))
    });
}));

// -----------------------------------------------------------------------------
// Messaging (reads use the caller's RLS-scoped client; writes use service role
// only after explicit participant checks)
// -----------------------------------------------------------------------------
const MESSAGE_MAX = 1000;
const CONTEXT_SOURCES = {
    listing: { table: 'listings', idCol: 'listing_id', ownerCol: 'user_id', titleCol: 'title' },
    tutoring: { table: 'tutoring_listings', idCol: 'tutoring_id', ownerCol: 'tutor_id', titleCol: 'subject' },
    event: { table: 'events', idCol: 'event_id', ownerCol: 'organiser_id', titleCol: 'title' }
};

async function notifyMessage(conv, sender, body) {
    const recipient = conv.user_a === sender.id ? conv.user_b : conv.user_a;
    await notifyUsers([{ user_id: recipient, type: 'Message', message: `${sender.name}: ${body}`.slice(0, 200), related_conversation_id: conv.conversation_id }]);
}

// Start (or continue) a conversation and send the first message.
app.post('/conversations', authenticateToken, rateLimit(60, 15 * 60 * 1000), asyncHandler(async (req, res) => {
    const body = str(req.body.body);
    if (!body || body.length > MESSAGE_MAX) return res.status(400).json({ error: `Message must be 1-${MESSAGE_MAX} characters` });
    const type = req.body.context_type || 'direct';
    let recipient, contextId = null, title = null;
    if (type === 'direct') {
        recipient = str(req.body.recipient_id);
        const p = recipient ? await getProfile(adminClient, recipient).catch(() => null) : null;
        if (!p || !p.is_active) return res.status(404).json({ error: 'User not found' });
    } else if (CONTEXT_SOURCES[type]) {
        const src = CONTEXT_SOURCES[type];
        contextId = str(req.body.context_id);
        const { data, error } = await adminClient.from(src.table).select(`${src.ownerCol},${src.titleCol}`).eq(src.idCol, contextId).maybeSingle();
        if (error) throw dbError(error);
        if (!data) return res.status(404).json({ error: 'That post no longer exists' });
        recipient = data[src.ownerCol]; title = data[src.titleCol];
    } else return res.status(400).json({ error: 'Invalid conversation type' });
    if (recipient === req.user.id) return res.status(400).json({ error: "You can't message yourself" });

    const [user_a, user_b] = [req.user.id, recipient].sort();
    const find = () => {
        let q = adminClient.from('conversations').select('*').eq('user_a', user_a).eq('user_b', user_b).eq('context_type', type);
        q = contextId ? q.eq('context_id', contextId) : q.is('context_id', null);
        return q.maybeSingle();
    };
    let { data: conv, error } = await find();
    if (error) throw dbError(error);
    if (!conv) {
        ({ data: conv, error } = await adminClient.from('conversations').insert({ user_a, user_b, context_type: type, context_id: contextId, context_title: title }).select('*').single());
        if (error?.code === '23505') ({ data: conv, error } = await find());
        if (error) throw dbError(error);
    }
    const { error: msgError } = await adminClient.from('messages').insert({ conversation_id: conv.conversation_id, sender_id: req.user.id, body });
    if (msgError) throw dbError(msgError);
    await adminClient.from('conversations').update({ last_message_at: new Date().toISOString() }).eq('conversation_id', conv.conversation_id);
    await notifyMessage(conv, req.user, body);
    res.status(201).json({ message: 'Message sent', conversation_id: conv.conversation_id });
}));

app.get('/conversations', authenticateToken, asyncHandler(async (req, res) => {
    const db = req.user.db, me = req.user.id;
    const { data: convs, error } = await db.from('conversations').select('*').or(`user_a.eq.${me},user_b.eq.${me}`).order('last_message_at', { ascending: false }).limit(100);
    if (error) throw dbError(error);
    const rows = convs || [];
    const ids = rows.map(c => c.conversation_id);
    let msgs = [];
    if (ids.length) {
        const { data, error: mErr } = await db.from('messages').select('conversation_id,sender_id,body,read_at,created_at').in('conversation_id', ids).order('created_at', { ascending: false }).limit(2000);
        if (mErr) throw dbError(mErr);
        msgs = data || [];
    }
    const last = new Map(), unread = new Map();
    for (const m of msgs) {
        if (!last.has(m.conversation_id)) last.set(m.conversation_id, m);
        if (!m.read_at && m.sender_id !== me) unread.set(m.conversation_id, (unread.get(m.conversation_id) || 0) + 1);
    }
    const profiles = await profileMap(db, rows.map(c => (c.user_a === me ? c.user_b : c.user_a)));
    const conversations = rows.map(c => {
        const otherId = c.user_a === me ? c.user_b : c.user_a;
        const l = last.get(c.conversation_id);
        return { conversation_id: c.conversation_id, other_user_id: otherId, other_name: profiles.get(otherId)?.name || 'Unknown', context_type: c.context_type, context_title: c.context_title,
            last_message: l ? { body: l.body, mine: l.sender_id === me, created_at: l.created_at } : null, unread: unread.get(c.conversation_id) || 0, last_message_at: c.last_message_at };
    });
    res.json({ conversations, unread_total: conversations.reduce((a, c) => a + c.unread, 0) });
}));

app.get('/conversations/:id/messages', authenticateToken, asyncHandler(async (req, res) => {
    const { data: conv, error } = await req.user.db.from('conversations').select('*').eq('conversation_id', req.params.id).maybeSingle();
    if (error) throw dbError(error);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    const { data: messages, error: mErr } = await req.user.db.from('messages').select('message_id,sender_id,body,read_at,created_at').eq('conversation_id', conv.conversation_id).order('created_at', { ascending: true }).limit(500);
    if (mErr) throw dbError(mErr);
    // Opening a thread marks the other person's messages and related notifications as read.
    await adminClient.from('messages').update({ read_at: new Date().toISOString() }).eq('conversation_id', conv.conversation_id).neq('sender_id', req.user.id).is('read_at', null);
    await adminClient.from('notifications').update({ is_read: true }).eq('user_id', req.user.id).eq('related_conversation_id', conv.conversation_id).eq('is_read', false);
    const otherId = conv.user_a === req.user.id ? conv.user_b : conv.user_a;
    const profiles = await profileMap(req.user.db, [otherId]);
    res.json({
        conversation: { conversation_id: conv.conversation_id, context_type: conv.context_type, context_id: conv.context_id, context_title: conv.context_title, other_user_id: otherId, other_name: profiles.get(otherId)?.name || 'Unknown' },
        messages: (messages || []).map(m => ({ ...m, mine: m.sender_id === req.user.id }))
    });
}));

app.post('/conversations/:id/messages', authenticateToken, rateLimit(120, 15 * 60 * 1000), asyncHandler(async (req, res) => {
    const body = str(req.body.body);
    if (!body || body.length > MESSAGE_MAX) return res.status(400).json({ error: `Message must be 1-${MESSAGE_MAX} characters` });
    const { data: conv, error } = await req.user.db.from('conversations').select('*').eq('conversation_id', req.params.id).maybeSingle();
    if (error) throw dbError(error);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    const { data, error: msgError } = await adminClient.from('messages').insert({ conversation_id: conv.conversation_id, sender_id: req.user.id, body }).select('message_id,created_at').single();
    if (msgError) throw dbError(msgError);
    await adminClient.from('conversations').update({ last_message_at: data.created_at }).eq('conversation_id', conv.conversation_id);
    await notifyMessage(conv, req.user, body);
    res.status(201).json({ message: 'Message sent', message_id: data.message_id });
}));

// -----------------------------------------------------------------------------
// Health / error handling
// -----------------------------------------------------------------------------
app.get('/health', asyncHandler(async (req, res) => {
    const { error } = await publicClient.from('profiles').select('id', { head: true, count: 'exact' });
    if (error) return res.status(503).json({ status: 'Database unavailable', error: error.message });
    // Reports whether the messaging migration has been applied (helps diagnose "relation does not exist" errors).
    const { error: msgErr } = await adminClient.from('conversations').select('conversation_id', { head: true, count: 'exact' });
    const { error: enumErr } = await adminClient.from('notifications').select('related_conversation_id', { head: true, count: 'exact' });
    res.json({ status: 'Backend healthy', version: '2.1', database: 'Supabase/PostgreSQL', authentication: 'Supabase Auth',
        messaging_tables: msgErr ? `MISSING - run supabase/migrations/20261007170000_messaging.sql (${msgErr.message})` : 'ok',
        notifications_link_column: enumErr ? `MISSING (${enumErr.message})` : 'ok', timestamp: new Date().toISOString() });
}));

app.use((req, res) => res.status(404).json({ error: 'Endpoint not found' }));
app.use((err, req, res, next) => {
    const status = Number(err.status || err.statusCode) || 500;
    if (status >= 500) console.error(err);
    if (res.headersSent) return next(err);
    const message = status < 500 ? (err.type === 'entity.parse.failed' ? 'Invalid JSON body' : err.message)
        : (IS_PROD ? 'Internal server error' : (err.message || 'Internal server error'));
    res.status(status).json({ error: message });
});

app.listen(PORT, () => {
    console.log(`\n Campus Connect Backend Running`);
    console.log(` Server: http://localhost:${PORT}`);
    console.log(`  Database: Supabase PostgreSQL`);
    console.log(` Authentication: Supabase Auth`);
    console.log(`  Authorization: PostgreSQL RLS + backend checks`);
    console.log(` Health Check: GET /health\n`);
});