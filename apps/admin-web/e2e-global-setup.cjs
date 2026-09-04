// Global setup: login once, write token to /tmp/e2e-auth.json
const { request } = require('@playwright/test');
const fs = require('fs');

const API = 'http://localhost:3105';
const USER = 'admin';
const PASS = 'admin123';
const AUTH_FILE = '/tmp/e2e-auth.json';

module.exports = async function globalSetup() {
  // Wait for rate limit to clear if needed, retry up to 5 times with 2s delay
  let lastErr;
  for (let i = 0; i < 5; i++) {
    const ctx = await request.newContext();
    const resp = await ctx.post(`${API}/api/auth/login`, {
      data: { username: USER, password: PASS },
    });
    const body = await resp.json();
    await ctx.dispose();

    if (body.data?.accessToken) {
      fs.writeFileSync(AUTH_FILE, JSON.stringify({
        token: body.data.accessToken,
        refreshToken: body.data.refreshToken,
        user: body.data.user || { id: 1, username: USER },
      }));
      console.log('[globalSetup] ✓ Token obtained and written to', AUTH_FILE);
      return;
    }

    lastErr = body.message || JSON.stringify(body);
    console.warn(`[globalSetup] attempt ${i+1} failed: ${lastErr}, retrying in 3s...`);
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error(`[globalSetup] login failed after retries: ${lastErr}`);
};
