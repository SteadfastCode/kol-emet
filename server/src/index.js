import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import mongoose from 'mongoose';

import entriesRouter from './routes/entries.js';
import tagsRouter from './routes/tags.js';
import openQuestionsRouter from './routes/openQuestions.js';
import authRouter from './routes/auth.js';
import './models/User.js';
import './models/OpenQuestion.js'; // ensure model is registered for population
import { requireAuth } from './middleware/auth.js';

const app = express();
const PORT = process.env.API_PORT ?? 3001;
const isProd = process.env.NODE_ENV === 'production';

app.use(cors({
  origin: process.env.CLIENT_ORIGIN,
  credentials: true,
}));
app.use(express.json());

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

app.use('/auth', authRouter);
app.use('/entries', requireAuth, entriesRouter);
app.use('/tags', requireAuth, tagsRouter);
app.use('/open-questions', requireAuth, openQuestionsRouter);

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
