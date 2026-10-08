// The real TCP socket for SMTP: Cloudflare's connect() with implicit TLS
// (smtp.gmail.com port 465). Only the scheduled sender uses it; tests inject a fake.

import { connect } from "cloudflare:sockets";
import type { Connect } from "./smtp";

export const cfConnect: Connect = (host, port) =>
  connect({ hostname: host, port }, { secureTransport: "on", allowHalfOpen: false });
