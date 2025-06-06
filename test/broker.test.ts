import * as _ from 'lodash';
import crypto from 'crypto';
import { setTimeout as timeout } from 'timers/promises';
import { Writable } from 'node:stream';

import { expect } from 'chai';
import amqplib, { Connection } from 'amqplib';

import { brokerOptions } from './config';
import Broker from '../src/amqplib_compat/broker';
import { createVhost, deleteVhost } from './rabbitmq-http/client';
import { IMessage } from 'ts-amqp/dist/interfaces/Basic';
import { once } from 'events';

class TestBroker extends Broker {
  createConnection() {
    return this._connectAmqp();
  }

  get connection(): Connection | undefined {
    return this.conn;
  }

  set connection(conn: Connection | undefined) {
    this.conn = conn;
  }

  get channelConsumers() {
    return this._channelConsumers;
  }
}

describe('Broker', () => {
  describe('Connection', function() {
    it('can access RabbitMQ', async () => {
      expect(brokerOptions.connection!.host, 'RABBITMQ_HOST').not.to.be.undefined;
      const broker = new Broker(brokerOptions);
      await broker.connect();
      await broker.shutdown();
    });

    it('initializes the channel pool', async () => {
      const broker = new Broker(brokerOptions);
      await broker.connect();
      expect(broker.pool).not.to.be.undefined;
      expect(broker.pool?.isOpen).to.be.true;
      expect(broker.pool?.numFreeChannels).to.be.equal(brokerOptions.poolSize);
      await broker.shutdown();
      expect(broker.pool).to.be.undefined;
    });

    it('does not connect again using the same connection', async () => {
      const broker = new Broker(brokerOptions);
      const p1 = broker.connect();
      const p2 = broker.connect();

      expect(p1 === p2).to.be.true;
      await p1;
      await broker.shutdown();
    });

    it('throws an error if RabbitMQ unavailable', async () => {
      const broker = new Broker({
        connection: {
          ...brokerOptions.connection!,
          port: 1234,
          maxRetries: 0
        },
        poolSize: 1
      });
      return broker.connect().then(() => {
        throw new Error('Unexpected connection to invalid AMQP server!');
      }, ex => {
        expect(ex.code).to.be.equal('ECONNREFUSED');
      });
    });

    it('tries the specified number of times to connect', async () => {
      const orig = amqplib.connect;
      let num_called = 0;
      amqplib.connect = function(url, socketOptions?: any) {
        num_called += 1;
        return orig(url, socketOptions);
      };

      const broker = new Broker({
        connection: {
          ...brokerOptions.connection!,
          port: 1234,
          maxRetries: 3,
          retryDelay: 5, // ms
        },
        poolSize: 1
      });

      try {
        await broker.connect();
        throw new Error('Unexpected connection to invalid AMQP server!');
      } catch {
        expect(num_called).to.be.equal(4);
      } finally {
        amqplib.connect = orig;
      }
    });
  });

  describe('Functionality', function() {
    const vhost = crypto.randomBytes(5).toString('hex');

    const broker = new TestBroker({
      poolSize: 1,
      connection: {
        ...brokerOptions.connection!,
        vhost
      }
    });

    before(async function() {
      await createVhost(vhost);

      await broker.connect();
      return broker;
    });

    after(async function() {
      await broker.shutdown();
      await deleteVhost(vhost);
    });

    it('can declare queues', async () => {
      await broker.queues([{
        name: 'q1',
        auto_delete: false,
        durable: false,
        exclusive: false
      }]);

      await broker.pool!.acquireAndRun(ch => ch.checkQueue('q1'));
    });

    it('can declare exchanges', async () => {
      await broker.exchanges([{
        name: 'e1',
        durable: false,
        type: 'direct',
      }]);

      await broker.pool!.acquireAndRun(ch => ch.checkExchange('e1'));
    });

    it('can bind exchanges to queues', async () => {
      await broker.bindings([{
        exchange: 'e1',
        queue: 'q1',
        routing_key: '#'
      }]);

      await broker.pool!.acquireAndRun(ch => ch.checkExchange('e1'));
    });

    async function publish(args: IMessage<unknown>) {
      const payload = { username: 'martianboy' };
      await broker.publish({
        body: payload,
        ...args
      });

      await broker.pool!.acquireAndRun(async ch => {
        let resolveFn: (msg: amqplib.ConsumeMessage | null) => void;
        const promise = new Promise<amqplib.ConsumeMessage | null>(resolve => {
          resolveFn = resolve;
        });

        const consumer = await ch.consume('q1', msg => resolveFn(msg));

        const delivery = await promise;
        await ch.cancel(consumer.consumerTag);
        ch.ackAll();

        if (!delivery) throw new Error('Empty delivery after publish!');
        const body = JSON.parse(delivery.content.toString('utf-8'));
        expect(body).to.include(payload);
      });
    }

    it('can publish a message to an exchange', async function() {
      await publish({
        routing_key: '#',
        exchange: 'e1',
      });
    });
    it('can publish a message to the default exchange', async function() {
      await publish({
        routing_key: 'q1',
      });
    });

    it('can consume from a queue', async function() {
      const consumer = await broker.consume('q1');
      const { consumerCount } = await broker.pool!.acquireAndRun(async ch => {
        return await ch.checkQueue('q1');
      });

      expect(consumerCount).to.be.eq(1);
      await consumer.cancel();

      expect(broker.channelConsumers.size).to.eq(1);
      expect([...broker.channelConsumers.values()][0].size).to.be.eq(0);
    });

    it('doesn\'t rewire if no consumers are registered', async function() {
      // cause a channel error
      await broker.pool!.acquireAndRun(async ch => {
        return ch.assertQueue('q1', { exclusive: true });
      }).then(() => {
        throw new Error('Expected assertQueue to fail!');
      }, () => {});
    });

    it('can rewire consumers to a new channel when one is lost', async function() {
      const consumers = await Promise.all(broker.consumeOver(['q1', 'q1', 'q1']));
      expect(consumers).to.have.length(3);

      // cause a channel error
      await broker.pool!.acquireAndRun(async ch => {
        return ch.assertQueue('q1', { exclusive: true });
      }).then(() => {
        throw new Error('Expected assertQueue to fail!');
      }, () => {});

      // Await the resume event on each consumer which is the signal that it is
      // back on a new channel and receiving messages again.
      await Promise.all(consumers.map(c => once(c.consumer, 'resume')));

      // Cancel all consumers
      await Promise.all(consumers.map(c => c.consumer.cancel()));
    });

    it('can consume from multiple queues', async function() {
      const consumers = await Promise.all(broker.consumeOver(['q1', 'q1', 'q1']));
      const { consumerCount } = await broker.pool!.acquireAndRun(async ch => {
        return await ch.checkQueue('q1');
      });

      expect(consumerCount).to.be.eq(3);
      await Promise.all(consumers.map(c => c.consumer.cancel()));
    });

    it('can consume multiple messages on a consumer with prefetch', async function() {
      await broker.queues([{
        name: 'q5',
        auto_delete: false,
        durable: false,
        exclusive: false
      }]);

      const pub = (body: object) => broker.publish({
        routing_key: 'q5',
        body
      });

      const messages = [
        { username: 'u1' },
        { username: 'u2' },
        { username: 'u3' },
      ];

      await Promise.all(messages.map(pub));

      const consumer = await broker.consume('q5', 5);

      return new Promise((done) => {
        let consumed = 0;
        consumer.pipe(new Writable({
          write(_chunk, _encoding, cb) {
            consumed += 1;
            if (consumed === 3) {
              consumer.cancel().then(() =>
                broker.pool!.acquireAndRun(ch => ch.deleteQueue('q5'))
              ).then(() => done());
            }
            cb();
          },
          objectMode: true
        }));
      });
    });

    it('can safely reset prefetch on the same channel', async function () {
      await broker.queues([
        {
          name: 'q5',
          auto_delete: false,
          durable: false,
          exclusive: false,
        },
      ]);

      const pub = (body: object) =>
        broker.publish({
          routing_key: 'q5',
          body,
        });

      const messages = [
        { username: 'u1' },
        { username: 'u2' },
        { username: 'u3' },
        { username: 'u4' },
        { username: 'u5' },
      ];

      await Promise.all(messages.map(pub));

      const consumer1 = await broker.consume('q5', 2);
      const consumer2 = await broker.consume('q5', 1);
      const consumer3 = await broker.consume('q5', 2);

      const consumed_counts = await Promise.all(
        [consumer1, consumer2, consumer3].map(
          (consumer) =>
            new Promise((_done) => {
              let consumed = 0;
              const done = _.debounce(() => _done(consumed), 100, {
                leading: false,
                trailing: true,
              });

              consumer.pipe(
                new Writable({
                  write(_chunk, _encoding, cb) {
                    consumed += 1;
                    done();
                    cb();
                  },
                  objectMode: true,
                })
              );
            })
        )
      );

      broker.pool!.acquireAndRun(ch => ch.deleteQueue('q5'));

      expect(consumed_counts).to.have.members([2, 1, 2]);
    });

    it('can publish multiple messages without overloading a channel', async function() {
      await broker.queues([{
        name: 'q2',
        auto_delete: false,
        durable: false,
        exclusive: false
      }]);

      let returnedFalseYet = false;
      for (let i = 0; i < 2500; i++) {
        const ret = await broker.publish({
          routing_key: 'q2',
          body: { message: 'Hello, World!' }
        });

        returnedFalseYet ||= !ret;
      }

      expect(returnedFalseYet).to.be.true;

      await broker.pool?.acquireAndRun(async ch => {
        let all_received = false;
        for (let i = 0; i < 5; i++) {
          const { messageCount } = await ch.checkQueue('q2');
          if (messageCount === 2500) {
            all_received = true;
            break;
          }
          await timeout(5);
        }
        expect(all_received, 'not all messages were received after 5 trials').to.be.true;
        await ch.deleteQueue('q2');
      });
    });
  });

  describe('Error handling', function() {
    describe('#consume()', function() {
      it('throws when not connected', async function() {
        const broker = new Broker(brokerOptions);
        try {
          await broker.consume('q1');
          throw new Error('Expected an error but none was thrown.');
        } catch (ex) {
          return;
        }
      });
    });
    describe('#shutdown()', function() {
      it('throws when not connected', async function() {
        const broker = new Broker(brokerOptions);
        try {
          await broker.shutdown();
          throw new Error('Expected an error but none was thrown.');
        } catch (ex) {
          return;
        }
      });

      it('throws when pool hasn\'t been initialized', async function() {
        const broker = new TestBroker(brokerOptions);
        broker.connection = await broker.createConnection();

        try {
          await broker.shutdown();
          throw new Error('Expected an error but none was thrown.');
        } catch (ex) {
          return;
        } finally {
          await broker.connection.close();
        }
      });
    });
  });
});
