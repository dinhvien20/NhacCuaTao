window.__APP_CONFIG__ = window.__APP_CONFIG__ || {};
const currentHost = window.location.hostname || 'localhost';
const currentProtocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
window.__APP_CONFIG__.apiBase = window.__APP_CONFIG__.apiBase || `${currentProtocol}//${currentHost}:5000/api`;
