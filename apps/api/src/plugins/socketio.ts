import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import { Server } from 'socket.io';

export default fp(async function socketioPlugin(app: FastifyInstance) {
  const io = new Server(app.server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    path: '/socket.io',
  });

  app.decorate('io', io);

  app.addHook('onClose', async () => {
    io.close();
  });
});

declare module 'fastify' {
  interface FastifyInstance {
    io: Server;
  }
}
