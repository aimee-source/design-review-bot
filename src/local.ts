import server from './app.js';

const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => console.log(`Listening on port ${port}`));
