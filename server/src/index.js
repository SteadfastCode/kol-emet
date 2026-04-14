import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import mongoose from 'mongoose';

import entriesRouter from './routes/entries.js';
import tagsRouter from './routes/tags.js';
import openQuestionsRouter from './routes/openQuestions.js';
import relationshipTypesRouter from './routes/relationshipTypes.js';
import authRouter from './routes/auth.js';
import mcpRouter from './routes/mcp.js';
import oauthRouter from './routes/oauth.js';
import eventsRouter from './routes/events.js';
import changelogRouter from './routes/changelog.js';
import './models/User.js';
import './models/OpenQuestion.js'; // ensure model is registered for population
import './models/RelationshipType.js';
import { requireAuth } from './middleware/auth.js';

const app = express();
const PORT = process.env.API_PORT ?? 3001;
const isProd = process.env.NODE_ENV === 'production';

app.set('trust proxy', 1); // trust Railway's reverse proxy so secure cookies work

app.use(cors({
  origin: process.env.CLIENT_ORIGIN,
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGO_URI }),
  cookie: {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    domain: isProd ? '.kol-emet.danielecker.dev' : undefined,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
}));

app.use('/', oauthRouter);
app.use('/auth', authRouter);
app.use('/mcp', mcpRouter);
app.use('/events', requireAuth, eventsRouter);
app.use('/entries', requireAuth, entriesRouter);
app.use('/', requireAuth, changelogRouter);
app.use('/tags', requireAuth, tagsRouter);
app.use('/open-questions', requireAuth, openQuestionsRouter);
app.use('/relationship-types', requireAuth, relationshipTypesRouter);

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log('Connected to MongoDB');
    app.listen(PORT, () => console.log(`API listening on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to connect to MongoDB:', err.message);
    process.exit(1);
  });
