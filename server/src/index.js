import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';

import entriesRouter from './routes/entries.js';
import tagsRouter from './routes/tags.js';
import openQuestionsRouter from './routes/openQuestions.js';
import './models/OpenQuestion.js'; // ensure model is registered for population
import { requireAuth } from './middleware/auth.js';

const app = express();
const PORT = process.env.API_PORT ?? 3001;

app.use(cors());
app.use(express.json());
app.use(requireAuth);

app.use('/entries', entriesRouter);
app.use('/tags', tagsRouter);
app.use('/open-questions', openQuestionsRouter);

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
