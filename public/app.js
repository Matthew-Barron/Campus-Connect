'use strict';

// ===== STATE & HELPERS =====
const API_URL = location.protocol.startsWith('http') ? '' : 'http://localhost:5000';
const VIEWS = ['marketplace', 'events', 'societies', 'tutoring', 'polls'];
let token = null;
let currentUser = null;
let lastFocus = null;

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => 'R' + Number(n).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (d) => new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const fmtDateTime = (d) => new Date(d).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const toSqlLocal = (v) => (v && v.length === 16 ? v + ':00' : v); // datetime-local -> "YYYY-MM-DDTHH:MM:SS"

function ago(d) {
    const s = Math.floor((Date.now() - new Date(d)) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return fmtDate(d);
}

async function api(endpoint, method = 'GET', body = null) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (token) opts.headers.Authorization = `Bearer ${token}`;
    if (body) opts.body = JSON.stringify(body);

    let res;
    try {
        res = await fetch(API_URL + endpoint, opts);
    } catch {
        throw new Error("Can't reach the server. Check your connection and try again.");
    }
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON response */ }
    if (res.status === 401 && token) {
        endSession();
        throw new Error(data.error || 'Session expired. Please log in again.');
    }
    if (!res.ok) throw new Error(data.error || 'Something went wrong');
    return data;
}

function toast(message, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), type === 'error' ? 5500 : 3500);
}

// Run an async action while a button is disabled so it can't be double-submitted
async function withBusy(btn, fn) {
    if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = 'Please wait…'; }
    try { return await fn(); }
    finally { if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = btn.dataset.label; } }
}

// ===== MODAL =====
function openModal(title, html) {
    lastFocus = document.activeElement;
    $('#modal-body').innerHTML = `<h2 id="modal-title">${esc(title)}</h2>${html}`;
    $('#modal-overlay').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    const first = $('#modal-body input, #modal-body textarea, #modal-body select, #modal-body button');
    (first || $('#modal-close')).focus();
}
function closeModal() {
    $('#modal-overlay').classList.add('hidden');
    $('#modal-body').innerHTML = '';
    document.body.style.overflow = '';
    if (lastFocus && lastFocus.isConnected) lastFocus.focus();
}
function formError(form, msg) {
    let el = $('.form-error', form);
    if (!el) { el = document.createElement('div'); el.className = 'form-error'; el.setAttribute('role', 'alert'); form.prepend(el); }
    el.textContent = msg;
}

// ===== SESSION =====
function endSession() {
    token = null; currentUser = null;
    try { localStorage.removeItem('token'); } catch { /* storage unavailable */ }
    closeModal();
    renderRoute();
}

function startSession(result) {
    token = result.token;
    currentUser = result.user;
    try { localStorage.setItem('token', token); } catch { /* storage unavailable */ }
    if (!VIEWS.includes(location.hash.slice(1))) location.hash = '#marketplace';
    renderRoute();
}

// ===== ROUTER =====
function renderRoute() {
    const loggedIn = !!currentUser;
    $('#app-header').classList.toggle('hidden', !loggedIn);
    if (!loggedIn) { renderAuth(); document.title = 'Log in · Campus Connect'; return; }

    $('#user-name').textContent = currentUser.name;
    const name = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'marketplace';
    document.querySelectorAll('#main-nav a').forEach(a => {
        const on = a.dataset.view === name;
        a.classList.toggle('active', on);
        on ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current');
    });
    document.title = name[0].toUpperCase() + name.slice(1) + ' · Campus Connect';
    ({ marketplace: loadListings, events: loadEvents, societies: loadSocieties, tutoring: loadTutoring, polls: loadPolls })[name]();
    loadNotifications();
}
window.addEventListener('hashchange', () => { if (currentUser) { renderRoute(); window.scrollTo(0, 0); } });

const skeletons = (n = 6) => `<div class="grid" aria-busy="true">${'<div class="skeleton"></div>'.repeat(n)}</div>`;
const emptyState = (icon, title, hint) => `<div class="empty"><span class="big">${icon}</span><strong>${esc(title)}</strong><p>${esc(hint)}</p></div>`;
const errorState = (msg, retry) => `<div class="error-box">${esc(msg)}<br><button class="btn btn-secondary btn-sm" data-action="${retry}" style="margin-top:.75rem">Try again</button></div>`;
const head = (title, buttonHtml = '', extra = '') => `<div class="view-head"><h1>${title}</h1><div class="toolbar">${extra}${buttonHtml}</div></div>`;

// ===== AUTH =====
function renderAuth(tab = 'login') {
    view.innerHTML = `
    <div class="card auth-card">
        <div class="auth-brand"><div class="logo-big">🎓</div><h1>Campus Connect</h1><p class="meta">Marketplace, events, societies &amp; tutoring for verified students</p></div>
        <div class="tabs" role="tablist">
            <button class="tab" role="tab" data-action="auth-tab" data-tab="login" aria-selected="${tab === 'login'}">Log in</button>
            <button class="tab" role="tab" data-action="auth-tab" data-tab="register" aria-selected="${tab === 'register'}">Register</button>
        </div>
        ${tab === 'login' ? `
        <form data-form="login" novalidate>
            <div class="form-group"><label for="login-email">Campus email</label>
                <input type="email" id="login-email" name="email" autocomplete="username" placeholder="you@campus.ac.za" required></div>
            <div class="form-group"><label for="login-password">Password</label>
                <div class="pw-wrap"><input type="password" id="login-password" name="password" autocomplete="current-password" required>
                <button type="button" class="pw-toggle" data-action="toggle-pw">Show</button></div></div>
            <button class="btn" type="submit">Log in</button>
            <p class="meta" style="text-align:center;margin-top:1rem"><button type="button" class="btn-link" data-action="forgot">Forgot password?</button></p>
        </form>` : `
        <form data-form="register" novalidate>
            <div class="form-group"><label for="reg-name">Full name</label><input type="text" id="reg-name" name="name" autocomplete="name" maxlength="100" required></div>
            <div class="form-group"><label for="reg-email">Campus email</label><input type="email" id="reg-email" name="email" autocomplete="username" placeholder="you@campus.ac.za" required>
                <div class="hint">Must end in @campus.ac.za</div></div>
            <div class="form-group"><label for="reg-student">Student number</label><input type="text" id="reg-student" name="student_number" maxlength="20" required></div>
            <div class="form-group"><label for="reg-password">Password</label>
                <div class="pw-wrap"><input type="password" id="reg-password" name="password" autocomplete="new-password" required>
                <button type="button" class="pw-toggle" data-action="toggle-pw">Show</button></div>
                <div class="hint">At least 8 characters, with a letter and a number</div></div>
            <button class="btn" type="submit">Create account</button>
        </form>`}
    </div>`;
    const first = $('input', view);
    if (first && !matchMedia('(pointer: coarse)').matches) first.focus();
}

function validatePassword(pw) {
    if (pw.length < 8 || !/\d/.test(pw) || !/[a-zA-Z]/.test(pw)) return 'Password must be at least 8 characters with a letter and a number';
    return null;
}

const forms = {
    async login(form, d) {
        if (!d.email || !d.password) return formError(form, 'Enter your email and password');
        startSession(await api('/auth/login', 'POST', d));
        toast(`Welcome back, ${currentUser.name.split(' ')[0]}!`, 'success');
    },
    async register(form, d) {
        if (!/^[^\s@]+@campus\.ac\.za$/i.test(d.email.trim())) return formError(form, 'Use your campus email (ending in @campus.ac.za)');
        const pwErr = validatePassword(d.password);
        if (pwErr) return formError(form, pwErr);
        startSession(await api('/auth/register', 'POST', d));
        toast('Account created. Welcome to Campus Connect!', 'success');
    },
    async forgot(form, d) {
        const res = await api('/auth/forgot-password', 'POST', d);
        openResetForm(res.reset_token);
    },
    async reset(form, d) {
        const pwErr = validatePassword(d.new_password);
        if (pwErr) return formError(form, pwErr);
        await api('/auth/reset-password', 'POST', d);
        closeModal();
        toast('Password reset. You can log in now.', 'success');
    },
    async listing(form, d) {
        await api('/listings', 'POST', { title: d.title, description: d.description, price: parseFloat(d.price) });
        closeModal(); toast('Listing created', 'success'); loadListings();
    },
    async response(form, d) {
        await api(`/listings/${d.id}/responses`, 'POST', { message: d.message });
        closeModal(); toast('Message sent to the seller', 'success');
    },
    async event(form, d) {
        await api('/events', 'POST', { title: d.title, description: d.description, location: d.location, date_time: toSqlLocal(d.date_time) });
        closeModal(); toast('Event created', 'success'); loadEvents();
    },
    async society(form, d) {
        await api('/societies', 'POST', d);
        closeModal(); toast('Society created', 'success'); loadSocieties();
    },
    async tutoring(form, d) {
        await api('/tutoring', 'POST', { subject: d.subject, rate: parseFloat(d.rate), availability: d.availability, description: d.description });
        closeModal(); toast('Tutoring listing created', 'success'); loadTutoring();
    },
    async poll(form, d) {
        const options = [d.opt1, d.opt2, d.opt3, d.opt4].map(o => (o || '').trim()).filter(Boolean);
        if (new Set(options).size < options.length) return formError(form, 'Options must be different from each other');
        await api('/polls', 'POST', { question: d.question, options, closes_at: toSqlLocal(d.closes_at) });
        closeModal(); toast('Poll created', 'success'); loadPolls();
    },
    async vote(form, d) {
        if (!d.option) return formError(form, 'Pick an option first');
        await api(`/polls/${d.id}/vote`, 'POST', { selected_option: d.option });
        toast('Vote recorded', 'success'); loadPolls();
    }
};

function openForgotForm() {
    openModal('Reset your password', `
    <p class="meta" style="margin-bottom:1rem">Enter your campus email and student number and we'll send you a reset code.</p>
    <form data-form="forgot" novalidate>
        <div class="form-group"><label for="f-email">Campus email</label><input type="email" id="f-email" name="email" required></div>
        <div class="form-group"><label for="f-student">Student number</label><input type="text" id="f-student" name="student_number" required></div>
        <div class="modal-actions"><button type="button" class="btn btn-secondary" data-action="close-modal">Cancel</button><button class="btn" type="submit">Send reset code</button></div>
    </form>`);
}
function openResetForm(devToken) {
    openModal('Enter reset code', `
    <p class="meta" style="margin-bottom:1rem">If your details matched an account, a code is on its way. Enter it below with your new password.
    ${devToken ? '<br><strong>Dev mode:</strong> the code has been filled in for you.' : ''}</p>
    <form data-form="reset" novalidate>
        <div class="form-group"><label for="r-token">Reset code</label><input type="text" id="r-token" name="reset_token" value="${esc(devToken || '')}" required></div>
        <div class="form-group"><label for="r-pw">New password</label><input type="password" id="r-pw" name="new_password" autocomplete="new-password" required>
            <div class="hint">At least 8 characters, with a letter and a number</div></div>
        <div class="modal-actions"><button type="button" class="btn btn-secondary" data-action="close-modal">Cancel</button><button class="btn" type="submit">Reset password</button></div>
    </form>`);
}

// ===== MARKETPLACE =====
const mk = { search: '', status: '' };
async function loadListings() {
    view.innerHTML = head('🛒 Marketplace', '<button class="btn" data-action="new-listing">+ New listing</button>', `
        <input type="search" id="mk-search" placeholder="Search listings" aria-label="Search listings" value="${esc(mk.search)}">
        <select id="mk-status" aria-label="Filter by status">
            ${['', 'Available', 'Pending', 'Sold'].map(s => `<option value="${s}" ${mk.status === s ? 'selected' : ''}>${s || 'All statuses'}</option>`).join('')}
        </select>`) + `<div id="mk-list">${skeletons()}</div>`;
    fetchListings();
}
async function fetchListings() {
    const box = $('#mk-list'); if (!box) return;
    try {
        const qs = new URLSearchParams();
        if (mk.status) qs.set('status', mk.status);
        if (mk.search) qs.set('search', mk.search);
        const { listings } = await api('/listings?' + qs);
        if ($('#mk-list') !== box) return; // user navigated away
        box.innerHTML = `<div class="grid">${listings.length ? listings.map(l => `
        <article class="card">
            <div class="row"><h3>${esc(l.title)}</h3><span class="pill pill-${esc(l.status.toLowerCase())}">${esc(l.status)}</span></div>
            <p class="desc">${esc(l.description) || '<em>No description</em>'}</p>
            <div class="price">${money(l.price)}</div>
            <p class="meta">${l.user_id === currentUser.user_id ? 'Your listing' : 'By ' + esc(l.seller_name)} · ${ago(l.created_at)}</p>
            <div class="actions"><button class="btn btn-secondary btn-sm" data-action="view-listing" data-id="${l.listing_id}">${l.user_id === currentUser.user_id ? 'Manage' : 'View &amp; message'}</button></div>
        </article>`).join('') : emptyState('🛍️', mk.search || mk.status ? 'No matching listings' : 'Nothing for sale yet', mk.search || mk.status ? 'Try a different search or filter.' : 'Be the first to list something.')}</div>`;
    } catch (e) { box.innerHTML = errorState(e.message, 'reload'); }
}

const newListingForm = () => openModal('New listing', `
    <form data-form="listing" novalidate>
        <div class="form-group"><label for="l-title">Title</label><input id="l-title" name="title" maxlength="150" required></div>
        <div class="form-group"><label for="l-desc">Description</label><textarea id="l-desc" name="description" placeholder="Condition, edition, pick-up location…"></textarea></div>
        <div class="form-group"><label for="l-price">Price (R)</label><input id="l-price" name="price" type="number" min="0.01" step="0.01" inputmode="decimal" required></div>
        <div class="modal-actions"><button type="button" class="btn btn-secondary" data-action="close-modal">Cancel</button><button class="btn" type="submit">Create listing</button></div>
    </form>`);

async function viewListing(id) {
    try {
        const { listing: l, responses, is_owner } = await api(`/listings/${id}`);
        const ownerTools = is_owner ? `
            <hr><h3>Your listing</h3>
            <div class="toolbar" style="margin:.5rem 0">
                ${['Available', 'Pending', 'Sold'].map(s => `<button class="btn btn-secondary btn-sm ${l.status === s ? 'selected' : ''}" data-action="set-status" data-id="${id}" data-status="${s}">${s}</button>`).join('')}
                <button class="btn btn-danger btn-sm" data-action="delete-listing" data-id="${id}">Delete</button>
            </div>
            <h3 style="margin-top:1rem">Messages (${responses.length})</h3>
            ${responses.length ? responses.map(r => `<div class="response"><strong>${esc(r.responder_name)}</strong> <span class="meta">· ${esc(r.responder_email)} · ${ago(r.created_at)}</span><br>${esc(r.message)}</div>`).join('') : '<p class="meta">No messages yet.</p>'}` : `
            <hr><h3>Message the seller</h3>
            <form data-form="response" novalidate>
                <input type="hidden" name="id" value="${id}">
                <div class="form-group"><textarea name="message" maxlength="500" required aria-label="Your message" placeholder="Hi, is this still available?" data-count="#msg-count"></textarea><div class="char-count" id="msg-count">0 / 500</div></div>
                <button class="btn" type="submit" ${l.status === 'Sold' ? 'disabled' : ''}>Send message</button>
                ${l.status === 'Sold' ? '<span class="meta"> This item has been sold.</span>' : ''}
            </form>`;
        openModal(l.title, `
            <div class="row"><div class="price">${money(l.price)}</div><span class="pill pill-${esc(l.status.toLowerCase())}">${esc(l.status)}</span></div>
            <p style="margin:.75rem 0;white-space:pre-line;overflow-wrap:anywhere">${esc(l.description) || '<em>No description</em>'}</p>
            <p class="meta">Seller: <strong>${esc(l.seller_name)}</strong>${l.seller_email ? ` · <a href="mailto:${esc(l.seller_email)}">${esc(l.seller_email)}</a>` : ''}</p>
            ${ownerTools}`);
    } catch (e) { toast(e.message, 'error'); }
}

// ===== EVENTS =====
async function loadEvents() {
    view.innerHTML = head('📅 Events', '<button class="btn" data-action="new-event">+ Create event</button>') + `<div id="ev-list">${skeletons()}</div>`;
    const box = $('#ev-list');
    try {
        const { events } = await api('/events');
        if ($('#ev-list') !== box) return;
        box.innerHTML = `<div class="grid">${events.length ? events.map(e => {
            const d = new Date(e.date_time);
            return `<article class="card">
            <div class="row" style="align-items:center"><div class="date-chip"><span class="d">${d.getDate()}</span><span class="m">${d.toLocaleString(undefined, { month: 'short' })}</span></div>
                <div style="flex:1"><h3>${esc(e.title)}</h3><p class="meta">🕒 ${fmtDateTime(e.date_time)}</p></div></div>
            ${e.location ? `<p class="meta">📍 ${esc(e.location)}</p>` : ''}
            ${e.description ? `<p class="desc">${esc(e.description)}</p>` : ''}
            <p class="meta">Organised by ${esc(e.organiser_name)} · ${plural(e.attending_count, 'person')} going · ${e.interested_count} interested</p>
            <div class="actions">
                <button class="btn btn-sm ${e.my_rsvp === 'Attending' ? '' : 'btn-secondary'}" data-action="rsvp" data-id="${e.event_id}" data-status="${e.my_rsvp === 'Attending' ? 'Not_Attending' : 'Attending'}" aria-pressed="${e.my_rsvp === 'Attending'}">${e.my_rsvp === 'Attending' ? '✓ Going' : 'Going'}</button>
                <button class="btn btn-sm ${e.my_rsvp === 'Interested' ? '' : 'btn-secondary'}" data-action="rsvp" data-id="${e.event_id}" data-status="${e.my_rsvp === 'Interested' ? 'Not_Attending' : 'Interested'}" aria-pressed="${e.my_rsvp === 'Interested'}">${e.my_rsvp === 'Interested' ? '★ Interested' : 'Interested'}</button>
            </div></article>`;
        }).join('') : emptyState('🎉', 'No upcoming events', 'Create one and let everyone know.')}</div>`;
    } catch (e) { box.innerHTML = errorState(e.message, 'reload'); }
}
const newEventForm = () => {
    const min = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    openModal('Create event', `
    <form data-form="event" novalidate>
        <div class="form-group"><label for="e-title">Title</label><input id="e-title" name="title" maxlength="150" required></div>
        <div class="form-group"><label for="e-dt">Date &amp; time</label><input id="e-dt" name="date_time" type="datetime-local" min="${min}" required></div>
        <div class="form-group"><label for="e-loc">Location</label><input id="e-loc" name="location" maxlength="200"></div>
        <div class="form-group"><label for="e-desc">Description</label><textarea id="e-desc" name="description"></textarea></div>
        <div class="modal-actions"><button type="button" class="btn btn-secondary" data-action="close-modal">Cancel</button><button class="btn" type="submit">Create event</button></div>
    </form>`);
};

// ===== SOCIETIES =====
async function loadSocieties() {
    view.innerHTML = head('👥 Societies', '<button class="btn" data-action="new-society">+ Create society</button>') + `<div id="so-list">${skeletons()}</div>`;
    const box = $('#so-list');
    try {
        const { societies } = await api('/societies');
        if ($('#so-list') !== box) return;
        box.innerHTML = `<div class="grid">${societies.length ? societies.map(s => {
            const mine = s.admin_user_id === currentUser.user_id;
            return `<article class="card">
            <div class="row"><h3>${esc(s.name)}</h3>${mine ? '<span class="pill pill-open">Admin</span>' : ''}</div>
            <p class="desc">${esc(s.description) || '<em>No description</em>'}</p>
            <p class="meta">${s.admin_name ? 'Admin: ' + esc(s.admin_name) + ' · ' : ''}${plural(Number(s.member_count), 'member')}</p>
            <div class="actions">${s.is_member
                ? `<button class="btn btn-secondary btn-sm" data-action="leave-society" data-id="${s.society_id}" data-name="${esc(s.name)}" ${mine ? 'disabled title="Admins can\'t leave their own society"' : ''}>✓ Joined · Leave</button>`
                : `<button class="btn btn-sm" data-action="join-society" data-id="${s.society_id}">Join</button>`}
                ${mine ? `<button class="btn btn-secondary btn-sm" data-action="members" data-id="${s.society_id}" data-name="${esc(s.name)}">Members</button>` : ''}
            </div></article>`;
        }).join('') : emptyState('🏛️', 'No societies yet', 'Start one for your club or interest group.')}</div>`;
    } catch (e) { box.innerHTML = errorState(e.message, 'reload'); }
}
const newSocietyForm = () => openModal('Create society', `
    <form data-form="society" novalidate>
        <div class="form-group"><label for="s-name">Name</label><input id="s-name" name="name" maxlength="100" required></div>
        <div class="form-group"><label for="s-desc">Description</label><textarea id="s-desc" name="description"></textarea></div>
        <div class="modal-actions"><button type="button" class="btn btn-secondary" data-action="close-modal">Cancel</button><button class="btn" type="submit">Create society</button></div>
    </form>`);

// ===== TUTORING =====
let tutorFilter = '';
async function loadTutoring() {
    view.innerHTML = head('👨‍🏫 Tutoring', '<button class="btn" data-action="new-tutoring">+ Offer tutoring</button>',
        `<input type="search" id="tu-filter" placeholder="Filter by subject" aria-label="Filter by subject" value="${esc(tutorFilter)}">`) + `<div id="tu-list">${skeletons()}</div>`;
    fetchTutoring();
}
async function fetchTutoring() {
    const box = $('#tu-list'); if (!box) return;
    try {
        const { listings } = await api('/tutoring' + (tutorFilter ? '?subject=' + encodeURIComponent(tutorFilter) : ''));
        if ($('#tu-list') !== box) return;
        box.innerHTML = `<div class="grid">${listings.length ? listings.map(t => `
        <article class="card">
            <h3>${esc(t.subject)}</h3>
            <div class="price">${money(t.rate)}<span class="meta"> / hour</span></div>
            <p class="desc">${esc(t.description) || 'Tutoring available'}</p>
            <p class="meta">📅 ${esc(t.availability) || 'Flexible'}</p>
            <p class="meta">Tutor: ${esc(t.tutor_name)}</p>
            <div class="actions">${t.tutor_id === currentUser.user_id ? '<span class="pill pill-open">Your listing</span>'
                : t.tutor_email ? `<a class="btn btn-sm" href="mailto:${esc(t.tutor_email)}?subject=${encodeURIComponent('Tutoring: ' + t.subject)}">✉ Contact tutor</a>` : ''}</div>
        </article>`).join('') : emptyState('📚', tutorFilter ? `No tutors for "${tutorFilter}"` : 'No tutors yet', tutorFilter ? 'Try a different subject.' : 'Offer your skills and earn some extra cash.')}</div>`;
    } catch (e) { box.innerHTML = errorState(e.message, 'reload'); }
}
const newTutoringForm = () => openModal('Offer tutoring', `
    <form data-form="tutoring" novalidate>
        <div class="form-group"><label for="t-subj">Subject</label><input id="t-subj" name="subject" maxlength="100" placeholder="e.g. Calculus 1" required></div>
        <div class="form-group"><label for="t-rate">Hourly rate (R)</label><input id="t-rate" name="rate" type="number" min="0.01" step="0.01" inputmode="decimal" required></div>
        <div class="form-group"><label for="t-av">Availability</label><input id="t-av" name="availability" maxlength="200" placeholder="e.g. Mon–Fri 4–8pm"></div>
        <div class="form-group"><label for="t-desc">Description</label><textarea id="t-desc" name="description"></textarea></div>
        <div class="modal-actions"><button type="button" class="btn btn-secondary" data-action="close-modal">Cancel</button><button class="btn" type="submit">Create listing</button></div>
    </form>`);

// ===== POLLS =====
async function loadPolls() {
    view.innerHTML = head('🗳️ Polls', '<button class="btn" data-action="new-poll">+ Create poll</button>') + `<div id="po-list">${skeletons(3)}</div>`;
    const box = $('#po-list');
    try {
        const { polls } = await api('/polls');
        if ($('#po-list') !== box) return;
        box.innerHTML = `<div class="grid">${polls.length ? polls.map(p => {
            const total = p.results ? Object.values(p.results).reduce((a, b) => a + b, 0) : 0;
            const body = p.results
                ? p.options.map(o => { const n = p.results[o] || 0, pct = total ? Math.round(n / total * 100) : 0; return `
                    <div class="result"><div class="result-top"><span class="${p.my_vote === o ? 'mine' : ''}">${esc(o)}${p.my_vote === o ? ' ✓ your vote' : ''}</span><span>${pct}% · ${n}</span></div>
                    <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div></div>`; }).join('')
                : `<form data-form="vote" novalidate><input type="hidden" name="id" value="${p.poll_id}">
                    ${p.options.map(o => `<label class="poll-option"><input type="radio" name="option" value="${esc(o)}"> ${esc(o)}</label>`).join('')}
                    <button class="btn btn-sm" type="submit">Vote</button></form>`;
            return `<article class="card">
                <div class="row"><h3>${esc(p.question)}</h3><span class="pill ${p.is_active ? 'pill-open' : 'pill-closed'}">${p.is_active ? 'Open' : 'Closed'}</span></div>
                <p class="meta">By ${esc(p.creator_name)} · ${plural(Number(p.vote_count), 'vote')} · ${p.is_active ? 'closes ' + fmtDateTime(p.closes_at) : 'closed ' + fmtDate(p.closes_at)}</p>
                ${body}</article>`;
        }).join('') : emptyState('🗳️', 'No polls right now', 'Ask the campus a question.')}</div>`;
    } catch (e) { box.innerHTML = errorState(e.message, 'reload'); }
}
const newPollForm = () => {
    const min = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    openModal('Create poll', `
    <form data-form="poll" novalidate>
        <div class="form-group"><label for="p-q">Question</label><input id="p-q" name="question" maxlength="255" required></div>
        <div class="form-group"><label for="p-1">Option 1</label><input id="p-1" name="opt1" maxlength="255" required></div>
        <div class="form-group"><label for="p-2">Option 2</label><input id="p-2" name="opt2" maxlength="255" required></div>
        <div class="form-group"><label for="p-3">Option 3 (optional)</label><input id="p-3" name="opt3" maxlength="255"></div>
        <div class="form-group"><label for="p-4">Option 4 (optional)</label><input id="p-4" name="opt4" maxlength="255"></div>
        <div class="form-group"><label for="p-c">Closes at</label><input id="p-c" name="closes_at" type="datetime-local" min="${min}" required></div>
        <div class="modal-actions"><button type="button" class="btn btn-secondary" data-action="close-modal">Cancel</button><button class="btn" type="submit">Create poll</button></div>
    </form>`);
};

// ===== NOTIFICATIONS =====
let notifications = [];
async function loadNotifications() {
    try {
        const data = await api('/notifications');
        notifications = data.notifications;
        const badge = $('#unread-count');
        badge.textContent = data.unread_count > 99 ? '99+' : data.unread_count;
        badge.classList.toggle('hidden', !data.unread_count);
        $('#bell').setAttribute('aria-label', `Notifications${data.unread_count ? `, ${data.unread_count} unread` : ''}`);
        if (!$('#notif-panel').classList.contains('hidden')) renderNotifPanel();
    } catch { /* non-critical */ }
}
function renderNotifPanel() {
    const unread = notifications.some(n => !n.is_read);
    $('#notif-panel').innerHTML = `<div class="notif-head"><span>Notifications</span>${unread ? '<button class="btn-link" data-action="read-all">Mark all read</button>' : ''}</div>` +
        (notifications.length ? notifications.map(n => `<button class="notif-item ${n.is_read ? '' : 'unread'}" data-action="read-notif" data-id="${n.notification_id}" data-type="${esc(n.type)}">${esc(n.message)}<small>${ago(n.created_at)}</small></button>`).join('')
            : '<div class="empty" style="padding:2rem 1rem">You\'re all caught up 🎉</div>');
}
function toggleNotifPanel(force) {
    const panel = $('#notif-panel');
    const open = force ?? panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !open);
    $('#bell').setAttribute('aria-expanded', open);
    if (open) renderNotifPanel();
}

// ===== EVENT DELEGATION =====
document.addEventListener('submit', async (e) => {
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    const err = $('.form-error', form); if (err) err.remove();
    const data = Object.fromEntries(new FormData(form));
    // basic required-field check with friendly message
    const missing = [...form.querySelectorAll('[required]')].find(f => f.type !== 'radio' && !f.value.trim());
    if (missing) { missing.setAttribute('aria-invalid', 'true'); missing.focus(); return formError(form, 'Please fill in all required fields'); }
    const btn = $('button[type=submit]', form);
    try { await withBusy(btn, () => forms[form.dataset.form](form, data)); }
    catch (ex) { if (form.isConnected) formError(form, ex.message); else toast(ex.message, 'error'); }
});

const actions = {
    'auth-tab': (el) => renderAuth(el.dataset.tab),
    'toggle-pw': (el) => { const i = el.previousElementSibling; const show = i.type === 'password'; i.type = show ? 'text' : 'password'; el.textContent = show ? 'Hide' : 'Show'; },
    'forgot': openForgotForm,
    'close-modal': closeModal,
    'reload': renderRoute,
    'new-listing': newListingForm,
    'new-event': newEventForm,
    'new-society': newSocietyForm,
    'new-tutoring': newTutoringForm,
    'new-poll': newPollForm,
    'view-listing': (el) => viewListing(el.dataset.id),
    'set-status': async (el) => {
        await api(`/listings/${el.dataset.id}`, 'PUT', { status: el.dataset.status });
        toast(`Marked as ${el.dataset.status}`, 'success'); viewListing(el.dataset.id); fetchListings();
    },
    'delete-listing': async (el) => {
        if (!confirm('Delete this listing? This cannot be undone.')) return;
        await api(`/listings/${el.dataset.id}`, 'DELETE');
        closeModal(); toast('Listing deleted', 'success'); fetchListings();
    },
    'rsvp': async (el) => {
        await api(`/events/${el.dataset.id}/rsvp`, 'POST', { rsvp_status: el.dataset.status });
        loadEvents();
    },
    'join-society': async (el) => { await api(`/societies/${el.dataset.id}/join`, 'POST', {}); toast('Joined society', 'success'); loadSocieties(); },
    'leave-society': async (el) => {
        if (!confirm(`Leave ${el.dataset.name}?`)) return;
        await api(`/societies/${el.dataset.id}/leave`, 'DELETE'); toast('You left the society', 'info'); loadSocieties();
    },
    'members': async (el) => {
        const { members } = await api(`/societies/${el.dataset.id}/members`);
        openModal(`${el.dataset.name} · ${plural(members.length, 'member')}`, members.map(m =>
            `<div class="response"><strong>${esc(m.name)}</strong> <span class="meta">· ${esc(m.email)} · joined ${fmtDate(m.joined_at)}</span></div>`).join(''));
    },
    'bell': () => toggleNotifPanel(),
    'read-all': async () => { await api('/notifications/read-all', 'PUT'); await loadNotifications(); },
    'read-notif': async (el) => {
        const n = notifications.find(x => String(x.notification_id) === el.dataset.id);
        if (n && !n.is_read) await api(`/notifications/${n.notification_id}/read`, 'PUT');
        toggleNotifPanel(false);
        const target = { Event: 'events', Poll: 'polls', Listing: 'marketplace', Society: 'societies' }[el.dataset.type];
        if (target) location.hash = '#' + target;
        loadNotifications();
    },
    'logout': () => { endSession(); toast('Logged out', 'info'); }
};

document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) {
        if (!e.target.closest('.bell-wrap')) toggleNotifPanel(false);
        if (e.target.id === 'modal-overlay') closeModal();
        return;
    }
    const fn = actions[el.dataset.action];
    if (!fn) return;
    try { await fn(el); } catch (ex) { toast(ex.message, 'error'); }
});
$('#bell').addEventListener('click', () => toggleNotifPanel());
$('#logout-btn').addEventListener('click', actions.logout);
$('#modal-close').addEventListener('click', closeModal);

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (!$('#modal-overlay').classList.contains('hidden')) closeModal();
        else toggleNotifPanel(false);
    }
    // keep keyboard focus inside the modal
    if (e.key === 'Tab' && !$('#modal-overlay').classList.contains('hidden')) {
        const f = [...$('#modal').querySelectorAll('button, input, textarea, select, a[href]')].filter(x => !x.disabled && x.offsetParent !== null);
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
});

let debounce;
document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.getAttribute('aria-invalid')) t.removeAttribute('aria-invalid');
    if (t.dataset.count) $(t.dataset.count).textContent = `${t.value.length} / ${t.maxLength}`;
    if (t.id === 'mk-search') { clearTimeout(debounce); debounce = setTimeout(() => { mk.search = t.value.trim(); fetchListings(); }, 300); }
    if (t.id === 'tu-filter') { clearTimeout(debounce); debounce = setTimeout(() => { tutorFilter = t.value.trim(); fetchTutoring(); }, 300); }
});
document.addEventListener('change', (e) => {
    if (e.target.id === 'mk-status') { mk.status = e.target.value; fetchListings(); }
});

// Refresh notifications periodically and when the tab regains focus
setInterval(() => { if (currentUser && !document.hidden) loadNotifications(); }, 60000);
document.addEventListener('visibilitychange', () => { if (currentUser && !document.hidden) loadNotifications(); });

// ===== INIT =====
(async function init() {
    let saved = null;
    try { saved = localStorage.getItem('token'); } catch { /* storage unavailable */ }
    if (saved) {
        token = saved;
        try { currentUser = (await api('/auth/me')).user; }
        catch { token = null; currentUser = null; try { localStorage.removeItem('token'); } catch { /* ignore */ } }
    }
    renderRoute();
})();
