import { TOOLS } from '../src/tools';
import { checkPresets } from './fitPresets';

// split over two files so they run in parallel
checkPresets(TOOLS.filter((_, i) => i % 2 === 1));
