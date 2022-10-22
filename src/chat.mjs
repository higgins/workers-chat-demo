// This is the Edge Chat Demo Worker, built using Durable Objects!

// ===============================
// Introduction to Modules
// ===============================
//
// The first thing you might notice, if you are familiar with the Workers platform, is that this
// Worker is written differently from others you may have seen. It even has a different file
// extension. The `mjs` extension means this JavaScript is an ES Module, which, among other things,
// means it has imports and exports. Unlike other Workers, this code doesn't use
// `addEventListener("fetch", handler)` to register its main HTTP handler; instead, it _exports_
// a handler, as we'll see below.
//
// This is a new way of writing Workers that we expect to introduce more broadly in the future. We
// like this syntax because it is *composable*: You can take two workers written this way and
// merge them into one worker, by importing the two Workers' exported handlers yourself, and then
// exporting a new handler that call into the other Workers as appropriate.
//
// This new syntax is required when using Durable Objects, because your Durable Objects are
// implemented by classes, and those classes need to be exported. The new syntax can be used for
// writing regular Workers (without Durable Objects) too, but for now, you must be in the Durable
// Objects beta to be able to use the new syntax, while we work out the quirks.
//
// To see an example configuration for uploading module-based Workers, check out the wrangler.toml
// file or one of our Durable Object templates for Wrangler:
//   * https://github.com/cloudflare/durable-objects-template
//   * https://github.com/cloudflare/durable-objects-rollup-esm
//   * https://github.com/cloudflare/durable-objects-webpack-commonjs

// ===============================
// Required Environment
// ===============================
//
// This worker, when deployed, must be configured with two environment bindings:
// * rooms: A Durable Object namespace binding mapped to the ChatRoom class.
//
// Incidentally, in pre-modules Workers syntax, "bindings" (like KV bindings, secrets, etc.)
// appeared in your script as global variables, but in the new modules syntax, this is no longer
// the case. Instead, bindings are now delivered in an "environment object" when an event handler
// (or Durable Object class constructor) is called. Look for the variable `env` below.
//
// We made this change, again, for composability: The global scope is global, but if you want to
// call into existing code that has different environment requirements, then you need to be able
// to pass the environment as a parameter instead.
//
// Once again, see the wrangler.toml file to understand how the environment is configured.

// =======================================================================================
// The regular Worker part...
//
// This section of the code implements a normal Worker that receives HTTP requests from external
// clients. This part is stateless.

// With the introduction of modules, we're experimenting with allowing text/data blobs to be
// uploaded and exposed as synthetic modules. In wrangler.toml we specify a rule that files ending
// in .html should be uploaded as "Data", equivalent to content-type `application/octet-stream`.
// So when we import it as `HTML` here, we get the HTML content as an `ArrayBuffer`. This lets us
// serve our app's static asset without relying on any separate storage. (However, the space
// available for assets served this way is very limited; larger sites should continue to use Workers
// KV to serve assets.)
import HTML from "./chat.html";

// FROM const uniqueId = env.rooms.newUniqueId().toString();
const DO_NAME = '97b9e864b85221103adefa8613ade3424b22232eb47cf478349aec6800f5a991';

// `handleErrors()` is a little utility function that can wrap an HTTP request handler in a
// try/catch and return errors to the client. You probably wouldn't want to use this in production
// code but it is convenient when debugging and iterating.
async function handleErrors(request, func) {
  try {
    return await func();
  } catch (err) {
    console.log('////////////////////////', err);
    if (request.headers.get("Upgrade") == "websocket") {
      // Annoyingly, if we return an HTTP error in response to a WebSocket request, Chrome devtools
      // won't show us the response body! So... let's send a WebSocket response with an error
      // frame instead.
      let pair = new WebSocketPair();
      pair[1].accept();
      pair[1].send(JSON.stringify({error: err.stack}));
      pair[1].close(1011, "Uncaught exception during session setup");
      return new Response(null, { status: 101, webSocket: pair[0] });
    } else {
      return new Response(err.stack, {status: 500});
    }
  }
}

// In modules-syntax workers, we use `export default` to export our script's main event handlers.
// Here, we export one handler, `fetch`, for receiving HTTP requests. In pre-modules workers, the
// fetch handler was registered using `addEventHandler("fetch", event => { ... })`; this is just
// new syntax for essentially the same thing.
//
// `fetch` isn't the only handler. If your worker runs on a Cron schedule, it will receive calls
// to a handler named `scheduled`, which should be exported here in a similar way. We will be
// adding other handlers for other types of events over time.
export default {
  async fetch(request, env) {
    return await handleErrors(request, async () => {
      // We have received an HTTP request! Parse the URL and route the request.

      let url = new URL(request.url);
      let path = url.pathname.slice(1).split('/');

      // FIXME_JUSTIN: one admin API
      if (!path[0]) {
        // Serve our HTML at the root path.
        return new Response(HTML, {headers: {"Content-Type": "text/html;charset=UTF-8"}});
      }

      switch (path[0]) {
        case "api":
          // This is a request for `/api/...`, call the API handler.
          return handleApiRequest(path.slice(1), request, env);

        default:
          return new Response("Not found", {status: 404});
      }
    });
  }
}

async function handleApiRequest(path, request, env) {
  const roomObject = env.rooms.get(env.rooms.idFromString(DO_NAME));
  // We've received at API request. Route the request based on the path.
  switch (path[0]) {
    case "join": {
      // Request for `/api/join`.
      // Get the Durable Object stub for this room! The stub is a client object that can be used
      // to send messages to the remote Durable Object instance. The stub is returned immediately;
      // there is no need to await it. This is important because you would not want to wait for
      // a network round trip before you could start sending requests. Since Durable Objects are
      // created on-demand when the ID is first used, there's nothing to wait for anyway; we know
      // an object will be available somewhere to receive our requests.

      // Compute a new URL with `/api/room/<name>` removed. We'll forward the rest of the path
      // to the Durable Object.
      let newUrl = new URL(request.url);
      newUrl.pathname = "/websocket";

      // Send the request to the object. The `fetch()` method of a Durable Object stub has the
      // same signature as the global `fetch()` function, but the request is always sent to the
      // object, regardless of the request's URL.
      return roomObject.fetch(newUrl, request);
    }
    case "sup": {
      // FIXME_JUSTIN: check auth header
      // Request for `/api/sup` -- supapi sent us a new sup + message string
      let newUrl = new URL(request.url);
      newUrl.pathname = "/sup";

      // Send the request to the object. The `fetch()` method of a Durable Object stub has the
      // same signature as the global `fetch()` function, but the request is always sent to the
      // object, regardless of the request's URL.
      return roomObject.fetch(newUrl, request);
    }
    default:
      return new Response("Not found", {status: 404});
  }
}

// =======================================================================================
// The ChatRoom Durable Object Class

// ChatRoom implements a Durable Object that coordinates an individual chat room. Participants
// connect to the room using WebSockets, and the room broadcasts messages from each participant
// to all others.
export class ChatRoom {
  constructor(controller, env) {
    // `controller.storage` provides access to our durable storage. It provides a simple KV
    // get()/put() interface.
    this.storage = controller.storage;

    // `env` is our environment bindings (discussed earlier).
    this.env = env;

    // We will put the WebSocket objects for each client, along with some metadata, into
    // `sessions`.
    this.sessions = [];

    // We keep track of the last-seen message's timestamp just so that we can assign monotonically
    // increasing timestamps even if multiple messages arrive simultaneously (see below). There's
    // no need to store this to disk since we assume if the object is destroyed and recreated, much
    // more than a millisecond will have gone by.
    this.lastTimestamp = 0;
  }

  // The system will call fetch() whenever an HTTP request is sent to this Object. Such requests
  // can only be sent from other Worker code, such as the code above; these requests don't come
  // directly from the internet. In the future, we will support other formats than HTTP for these
  // communications, but we started with HTTP for its familiarity.
  async fetch(request) {
    return await handleErrors(request, async () => {
      let url = new URL(request.url);

      switch (url.pathname) {
        case "/websocket": {
          // The request is to `/api/room/<name>/websocket`. A client is trying to establish a new
          // WebSocket session.
          if (request.headers.get("Upgrade") != "websocket") {
            return new Response("expected websocket", {status: 400});
          }

          // To accept the WebSocket request, we create a WebSocketPair (which is like a socketpair,
          // i.e. two WebSockets that talk to each other), we return one end of the pair in the
          // response, and we operate on the other end. Note that this API is not part of the
          // Fetch API standard; unfortunately, the Fetch API / Service Workers specs do not define
          // any way to act as a WebSocket server today.
          let pair = new WebSocketPair();

          // We're going to take pair[1] as our end, and return pair[0] to the client.
          await this.handleSession(pair[1]);

          // Now we return the other end of the pair to the client.
          return new Response(null, { status: 101, webSocket: pair[0] });
        }
        case "/sup": {
          // FIXME: broadcast message to all clients
          this.broadcast(JSON.stringify({ sup_id: "73c870ed-524a-4c9f-a913-3315a97a0163", message: "This is a force updated client 2.0.2" }));
          return new Response("Published!", {status: 200});
        }

        default:
          return new Response("Not found", {status: 404});
      }
    });
  }

  // handleSession() implements our WebSocket-based chat protocol.
  async handleSession(webSocket) {
    // Accept our end of the WebSocket. This tells the runtime that we'll be terminating the
    // WebSocket in JavaScript, not sending it elsewhere.
    webSocket.accept();

    // Create our session and add it to the sessions list.
    // We don't send any messages to the client until it has sent us the initial user info
    // message. Until then, we will queue messages in `session.blockedMessages`.
    let session = { webSocket };
    this.sessions.push(session);

    // On "close" and "error" events, remove the WebSocket from the sessions list and broadcast
    // a quit message.
    let closeOrErrorHandler = evt => {
      session.quit = true;
      this.sessions = this.sessions.filter(member => member !== session);
      if (session.name) {
        this.broadcast({quit: session.name});
      }
    };
    webSocket.addEventListener("close", closeOrErrorHandler);
    webSocket.addEventListener("error", closeOrErrorHandler);
  }

  // broadcast() broadcasts a message to all clients.
  broadcast(message) {
    // Apply JSON if we weren't given a string to start with.
    if (typeof message !== "string") {
      message = JSON.stringify(message);
    }
    console.log('-------------------BROADCASTING MESSAGE: ', message);
    console.log('KNOWN SESSIONS: ', this.sessions.length);
    // Iterate over all the sessions sending them messages.
    this.sessions = this.sessions.filter(session => {
      try {
        session.webSocket.send(message);
        return true;
      } catch (err) {
        // Whoops, this connection is dead. Remove it from the list and arrange to notify
        // everyone below.
        session.quit = true;
        return false;
      }
    });
  }
}
