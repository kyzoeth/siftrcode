const View = require('./lib/view');
const v = new View('home.html', { defaultEngine: 'html', root: '/views', engines: { '.html': () => {} } });
if (typeof v.getRootDirectory !== 'function') process.exit(1);
if (v.getRootDirectory() !== '/views') process.exit(1);
process.exit(0);