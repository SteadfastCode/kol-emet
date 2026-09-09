/**
 * Bootstrap: load the environment, build the app, connect to MongoDB, listen.
 *
 * The app itself — middleware, session config and every route mount — lives in
 * `app.js` so that tests can construct it without a database. Keep this file to
 * process concerns only.
 */

import 'dotenv/config';
import mongoose from 'mongoose';

import { createApp } from './app.js';

const PORT = process.env.API_PORT ?? 3001;
const app = createApp();

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
