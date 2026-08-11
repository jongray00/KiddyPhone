// Baseline for D10: what KiddyPhone's worker does today. A hangup()-style
// rejection with a plain object, not awaited. Node 15+ default: process dies.
Promise.reject({ code: '404', message: 'Call not found' });
setTimeout(() => {
  console.log('still-alive');
}, 50);
