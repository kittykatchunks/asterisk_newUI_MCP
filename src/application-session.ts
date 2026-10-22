import { randomBytes,createHash } from "node:crypto";
import type { IncomingMessage,ServerResponse } from "node:http";
import { createRemoteJWKSet,jwtVerify } from "jose";
import type { AccessAudit } from "./diagnostic-api.ts";

export interface ApplicationSessionConfig {
  origin: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUrl: string;
  clientId: string;
  clientSecret: string;
  audience: string;
  allowLoopbackHttpForTests?: boolean;
}

interface Session {
  token: string;
  csrf: string;
  subject: string;
  customer: string;
  expiresAt: number;
}

export interface ApplicationSessionIdentity {
  sessionId: string;
  subject: string;
  customer: string;
  expiresAt: number;
}

const random=() => randomBytes(32).toString("base64url");
function cookie(request: IncomingMessage,name: string): string|undefined {
  const values=(request.headers.cookie??"").split(";").map((value) => value.trim())
    .filter((value) => value.startsWith(name+"="));
  return values.length===1? values[0].slice(name.length+1):undefined;
}

export function createApplicationSessions(input: ApplicationSessionConfig) {
  const config={ ...input };
  const origin=new URL(config.origin);
  const testHttp=config.allowLoopbackHttpForTests===true;
  const validate=(value: string) => {
    const url=new URL(value);
    if(url.username||url.password||url.hash||
      (url.protocol!=="https:"&&!(testHttp&&url.protocol==="http:"&&
        ["127.0.0.1","[::1]","localhost"].includes(url.hostname)))) {
      throw new Error("Application identity URLs require HTTPS; loopback HTTP is test-only");
    }
    return url;
  };
  for(const url of [config.origin,config.issuer,config.authorizationEndpoint,config.tokenEndpoint,config.jwksUrl]) validate(url);
  if(origin.origin!==config.origin||!config.clientId.trim()||!config.clientSecret.trim()||!config.audience.trim()) {
    throw new Error("Application session requires an exact origin and confidential client configuration");
  }
  for(const value of [config.authorizationEndpoint,config.tokenEndpoint,config.jwksUrl]) {
    if(new URL(value).origin!==new URL(config.issuer).origin) throw new Error("Identity endpoint origin mismatch");
  }
  const secure=origin.protocol==="https:";
  const sessionName=secure? "__Host-asterisk-session":"asterisk-test-session";
  const loginName=secure? "__Host-asterisk-login":"asterisk-test-login";
  const options=`; Path=/; HttpOnly; SameSite=Lax${secure? "; Secure":""}`;
  const callback=`${config.origin}/auth/callback`;
  const sessions=new Map<string,Session>();
  let exchanging=0;
  const pending=new Map<string,{ verifier: string; nonce: string; binding: string; customer: string; workspace: "reviews" | "agent"; expiresAt: number }>();
  const jwks=createRemoteJWKSet(new URL(config.jwksUrl),{ timeoutDuration: 2000 });
  const cleanup=() => {
    const now=Date.now();
    for(const [id,session] of sessions) if(session.expiresAt<=now) sessions.delete(id);
    for(const [id,login] of pending) if(login.expiresAt<=now) pending.delete(id);
  };
  const current=(request: IncomingMessage) => {
    cleanup();
    const id=cookie(request,sessionName);
    return id? sessions.get(id):undefined;
  };
  const sameOrigin=(request: IncomingMessage) =>
    request.headers.origin===config.origin&&
    (!request.headers["sec-fetch-site"]||request.headers["sec-fetch-site"]==="same-origin");
  const csrfValid=(request: IncomingMessage,session: Session) =>
    sameOrigin(request)&&request.headers["x-csrf-token"]===session.csrf;

  return {
    identity(request: IncomingMessage): ApplicationSessionIdentity | undefined {
      const session=current(request);
      const id=cookie(request,sessionName);
      if(!session||!id||request.headers.host!==origin.host) return undefined;
      return { sessionId: id,subject: session.subject,customer: session.customer,expiresAt: session.expiresAt };
    },
    authorization(request: IncomingMessage): { authorization?: string; subject?: string; csrfDenied: boolean } {
      const session=current(request);
      if(!session) return { csrfDenied: false };
      if(request.headers.authorization) return { csrfDenied: true,subject: session.subject };
      const mutation=!["GET","HEAD","OPTIONS"].includes(request.method??"");
      return { authorization: `Bearer ${session.token}`,subject: session.subject,csrfDenied: mutation&&!csrfValid(request,session) };
    },
    async handle(request: IncomingMessage,response: ServerResponse,requestId: string,
      audit: (event: AccessAudit) => Promise<void>): Promise<boolean> {
      const url=new URL(request.url??"/",config.origin);
      if(!["/auth/login","/auth/callback","/auth/session","/auth/logout"].includes(url.pathname)) return false;
      cleanup();
      const send=(status: number,code: string) => {
        response.writeHead(status).end(JSON.stringify({ code,requestId }));
      };
      const mutation=url.pathname==="/auth/logout";
      if(request.method!==(mutation? "POST":"GET")) {
        response.setHeader("Allow",mutation? "POST":"GET");
        send(405,"method_not_allowed");
        request.resume();
        return true;
      }
      if(request.headers.host!==origin.host) { send(400,"invalid_application_host"); return true; }
      if(url.pathname==="/auth/login") {
        const customer=url.searchParams.get("customer")??"";
        if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(customer)) { send(400,"invalid_login_customer"); return true; }
        const workspace=url.searchParams.get("workspace")??"reviews";
        if(workspace!=="reviews" && workspace!=="agent") { send(400,"invalid_login_workspace"); return true; }
        if(request.headers["sec-fetch-site"]==="cross-site") { send(403,"cross_site_login_denied"); return true; }
        if(pending.size>=1000) { send(503,"login_capacity_unavailable"); return true; }
        const state=random();
        const verifier=random();
        const nonce=random();
        const binding=random();
        pending.set(state,{ verifier,nonce,binding,customer,workspace,expiresAt: Date.now()+300000 });
        const authorize=new URL(config.authorizationEndpoint);
        authorize.search=new URLSearchParams({
          client_id: config.clientId,redirect_uri: callback,response_type: "code",
          scope: "openid",state,nonce,code_challenge_method: "S256",
          code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        }).toString();
        response.setHeader("Set-Cookie",`${loginName}=${binding}; Max-Age=300${options}`);
        response.writeHead(302,{ Location: authorize.href }).end();
        return true;
      }
      if(url.pathname==="/auth/callback") {
        const state=url.searchParams.get("state")??"";
        const login=pending.get(state);
        pending.delete(state);
        response.setHeader("Set-Cookie",`${loginName}=; Max-Age=0${options}`);
        if(!login||cookie(request,loginName)!==login.binding||
          url.searchParams.has("error")||url.searchParams.getAll("code").length!==1||
          url.searchParams.getAll("state").length!==1||!url.searchParams.get("code")) {
          send(400,"invalid_login_callback"); return true;
        }
        if(sessions.size+exchanging>=1000) { send(503,"session_capacity_unavailable"); return true; }
        exchanging++;
        try {
          const tokenResponse=await fetch(config.tokenEndpoint,{
            method: "POST",redirect: "error",signal: AbortSignal.timeout(5000),
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "authorization_code",code: url.searchParams.get("code")!,
              redirect_uri: callback,client_id: config.clientId,client_secret: config.clientSecret,
              code_verifier: login.verifier,
            }),
          });
          if(!tokenResponse.ok) { send(401,"login_exchange_rejected"); return true; }
          const tokens: unknown=await tokenResponse.json();
          if(typeof tokens!=="object"||tokens===null||
            !("access_token" in tokens)||typeof tokens.access_token!=="string"||
            !("id_token" in tokens)||typeof tokens.id_token!=="string") {
            throw new Error("Invalid application identity token response");
          }
          const id=await jwtVerify(tokens.id_token,jwks,{
            issuer: config.issuer,audience: config.clientId,algorithms: ["RS256"],
            requiredClaims: ["sub","iat","exp","nonce"],maxTokenAge: "15m",
          });
          const access=await jwtVerify(tokens.access_token,jwks,{
            issuer: config.issuer,audience: config.audience,algorithms: ["RS256"],
            requiredClaims: ["sub","iat","exp"],maxTokenAge: "15m",
          });
          if(id.payload.nonce!==login.nonce||!access.payload.sub?.trim()||access.payload.sub!==id.payload.sub) {
            send(401,"invalid_login_identity"); return true;
          }
          const expiresAt=Math.min(access.payload.exp!*1000,id.payload.exp!*1000,Date.now()+900000);
          if(expiresAt<=Date.now()) { send(401,"login_expired"); return true; }
          await audit({
            requestId,timestamp: new Date().toISOString(),customer: login.customer,
            subject: access.payload.sub,operation: "session-login",outcome: "application_login_completed",status: 200
          });
          const oldId=cookie(request,sessionName);
          if(oldId) sessions.delete(oldId);
          const sessionId=random();
          sessions.set(sessionId,{
            token: tokens.access_token,csrf: random(),
            subject: access.payload.sub,customer: login.customer,expiresAt
          });
          response.setHeader("Set-Cookie",[
            `${loginName}=; Max-Age=0${options}`,
            `${sessionName}=${sessionId}; Max-Age=${Math.ceil((expiresAt-Date.now())/1000)}${options}`,
          ]);
          response.writeHead(302,{ Location: login.workspace==="agent" ? `/agent/${login.customer}` : `/engineering/reviews/${login.customer}` }).end();
          return true;
        } finally { exchanging--; }
      }
      const session=current(request);
      if(!session) { send(401,"application_session_required"); return true; }
      if(url.pathname==="/auth/session") {
        if(request.headers["sec-fetch-site"]==="cross-site") { send(403,"cross_site_session_denied"); return true; }
        response.writeHead(200).end(JSON.stringify({
          customer: session.customer,csrf: session.csrf,
          expiresAt: new Date(session.expiresAt).toISOString()
        }));
        return true;
      }
      request.resume();
      if(!csrfValid(request,session)) { send(403,"invalid_session_csrf"); return true; }
      await audit({
        requestId,timestamp: new Date().toISOString(),customer: session.customer,
        subject: session.subject,operation: "session-logout",outcome: "application_logout_completed",status: 200
      });
      sessions.delete(cookie(request,sessionName)!);
      response.setHeader("Set-Cookie",`${sessionName}=; Max-Age=0${options}`);
      send(200,"application_logged_out");
      return true;
    },
  };
}
