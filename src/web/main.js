import * as virtual from '@tanstack/virtual-core';
import Alpine from 'alpinejs';
import { createCardSizer } from './card-size.ts';
import { jobReview } from './review.js';

window.TanStackVirtual = virtual;
window.createCardSizer = createCardSizer;
window.Alpine = Alpine;
Alpine.data('jobReview', () => jobReview());
Alpine.start();
