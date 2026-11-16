import 'dotenv/config';
import { createApp } from './app.js';
import { startGlobalSweep } from './sessions.js';
import { startEventWorker } from './zernio-events.js';
import {startTrackerReviewWorker} from './tracker-reviews.js';

createApp().listen(process.env.PORT || 3000,()=>console.log('VAAS Closer iniciado'));
startEventWorker();
startGlobalSweep();
startTrackerReviewWorker();
