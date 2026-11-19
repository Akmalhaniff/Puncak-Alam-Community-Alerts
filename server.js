import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { db } from './src/db/index.ts';
import { reports, users } from './src/db/schema.ts';
import { desc, eq } from 'drizzle-orm';
import { adminAuth } from './src/lib/firebase-admin.ts';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;
const HOST = '0.0.0.0';

app.use(express.json());
app.use(express.static(__dirname, {
  index: 'index.html',
  dotfiles: 'ignore'
}));

// Initialize Gemini client for server-side AI with Maps Grounding
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || '',
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
});

// Seed initial reports if table is empty
async function seedInitialReports() {
  try {
    const existing = await db.select().from(reports).limit(1);
    if (existing.length === 0) {
      console.log('Seeding initial community reports...');
      const initial = [
        { type: 'road', status: 'clear', area: 'Persiaran Mokhtar Dahari', details: 'Clear; ordinary traffic. Community update from the morning commute.', who: 'Community member', time: new Date('2026-11-19T09:18:00'), lat: 3.212, lng: 101.434, approximate: true },
        { type: 'road', status: 'clear', area: 'Avatar route', details: 'Reported passable in both directions. Conditions may have changed since this post.', who: 'Community member', time: new Date('2026-11-19T06:19:00'), lat: 3.222, lng: 101.447, approximate: true },
        { type: 'flood', status: 'danger', area: 'Fasa 1 traffic-light junction', details: 'Flooding reported at the junction; a later message suggested an alternate route. Treat this as an old observation.', who: 'Community member', time: new Date('2026-11-18T17:03:00'), lat: 3.212, lng: 101.434, approximate: true },
        { type: 'flood', status: 'danger', area: 'Alam Suria–Jeram, before Simpang 4', details: 'Reporter said water was around shin height and rising. This is a previous-day report.', who: 'Community member', time: new Date('2026-11-18T16:14:00'), lat: 3.241, lng: 101.413, approximate: true },
        { type: 'weather', status: 'uncertain', area: 'Hillpark', details: 'Heavy rain reported in the evening. No current water-level confirmation in the chat excerpt.', who: 'Community member', time: new Date('2026-11-18T21:38:00'), lat: 3.211, lng: 101.462, approximate: true }
      ];
      for (const r of initial) {
        await db.insert(reports).values(r);
      }
      console.log('Seed reports inserted successfully.');
    }
  } catch (err) {
    console.warn('Failed to seed initial reports (database might still be starting):', err.message);
  }
}

setTimeout(seedInitialReports, 2000);

// API Routes
app.get('/api/reports', async (_req, res) => {
  try {
    const allReports = await db.select().from(reports).orderBy(desc(reports.time));
    res.json(allReports);
  } catch (error) {
    console.error('Failed to fetch reports:', error);
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
});

app.post('/api/reports', async (req, res) => {
  try {
    const { type, status, area, details, who, lat, lng, approximate } = req.body;
    if (!type || !status || !area || !details) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    let userId = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const token = authHeader.split('Bearer ')[1];
        const decoded = await adminAuth.verifyIdToken(token);
        let dbUser = await db.select().from(users).where(eq(users.uid, decoded.uid)).limit(1);
        if (dbUser.length === 0) {
          const inserted = await db.insert(users).values({
            uid: decoded.uid,
            email: decoded.email || 'user@community.local',
            displayName: decoded.name || who || 'Community Member',
          }).returning();
          userId = inserted[0].id;
        } else {
          userId = dbUser[0].id;
        }
      } catch (err) {
        console.warn('Optional auth verification failed:', err.message);
      }
    }

    const newReport = await db.insert(reports).values({
      userId,
      type,
      status,
      area,
      details,
      who: who || 'Community member',
      lat: lat ? Number(lat) : null,
      lng: lng ? Number(lng) : null,
      approximate: approximate !== undefined ? approximate : true,
      time: new Date(),
    }).returning();

    res.status(201).json(newReport[0]);
  } catch (error) {
    console.error('Failed to create report:', error);
    res.status(500).json({ error: 'Failed to create report' });
  }
});

// AI Query Endpoint with Google Maps Grounding
app.post('/api/ai/query', async (req, res) => {
  try {
    const { prompt, lat, lng } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(400).json({ error: 'Gemini API key is not configured. Please check Settings > Secrets.' });
    }

    const retrievalConfig = lat && lng ? {
      retrievalConfig: {
        latLng: {
          latitude: Number(lat),
          longitude: Number(lng)
        }
      }
    } : {};

    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: prompt,
      config: {
        systemInstruction: 'You are Puncak Alam Community AI Assistant. Provide helpful, accurate information regarding weather, road conditions, and flood safety around Puncak Alam, Selangor. Reference Google Maps locations when available.',
        tools: [{ googleMaps: {} }],
        toolConfig: retrievalConfig
      }
    });

    const text = response.text || 'No response generated.';
    const groundingChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];

    res.json({ text, groundingChunks });
  } catch (error) {
    console.error('Gemini AI query error:', error);
    res.status(500).json({ text: 'AI query encountered an issue. Please check API key in Settings > Secrets.', error: error.message });
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
});
