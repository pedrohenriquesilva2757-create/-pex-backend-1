// =======================================================================
// ÁPEX — Backend (arquivo único)
// -----------------------------------------------------------------------
// Tudo num arquivo só de propósito: dá pra subir pelo site do GitHub
// direto do celular, sem precisar lidar com pastas. A lógica é
// exatamente a mesma da versão em múltiplos arquivos — só reorganizada.
//
// Pra rodar: precisa só deste arquivo + package.json + as variáveis de
// ambiente configuradas no Render (Environment → Environment Variables).
// =======================================================================

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { z } = require("zod");

// =======================================================================
// 1. BANCO DE DADOS
// =======================================================================
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10, idleTimeoutMillis: 30000 });
pool.on("error", (err) => console.error("Erro inesperado no pool do Postgres:", err));

// Schema completo — roda sozinho ao iniciar o servidor (idempotente: se
// a tabela já existe, ignora o erro). Você NÃO precisa rodar nada na mão.
const SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  razao_social VARCHAR(200) NOT NULL,
  cnpj VARCHAR(20) UNIQUE,
  plano VARCHAR(30) NOT NULL DEFAULT 'trial',
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS usuarios (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nome VARCHAR(150) NOT NULL,
  email VARCHAR(150) NOT NULL,
  telefone VARCHAR(20),
  senha_hash VARCHAR(255) NOT NULL,
  papel VARCHAR(20) NOT NULL DEFAULT 'OPERADOR',
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);
CREATE INDEX IF NOT EXISTS idx_usuarios_email ON usuarios(email);

CREATE TABLE IF NOT EXISTS tarifas_peso (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  peso_inicial NUMERIC(10,2) NOT NULL,
  peso_final NUMERIC(10,2) NOT NULL,
  valor_por_kg NUMERIC(10,2) NOT NULL,
  observacao VARCHAR(100),
  ativo BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS valor_km_veiculo (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tipo_veiculo VARCHAR(30) NOT NULL,
  valor_por_km NUMERIC(10,2) NOT NULL,
  peso_maximo_kg NUMERIC(10,2),
  UNIQUE (tenant_id, tipo_veiculo)
);

CREATE TABLE IF NOT EXISTS custo_km_veiculo (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tipo_veiculo VARCHAR(30) NOT NULL,
  custo_por_km NUMERIC(10,2) NOT NULL,
  UNIQUE (tenant_id, tipo_veiculo)
);

CREATE TABLE IF NOT EXISTS clientes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  empresa VARCHAR(150) NOT NULL,
  cnpj VARCHAR(20),
  contato_nome VARCHAR(150),
  telefone VARCHAR(20),
  email VARCHAR(150),
  cidade VARCHAR(100),
  condicao_pagamento VARCHAR(50) DEFAULT 'A vista',
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS veiculos (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  placa VARCHAR(10) NOT NULL,
  tipo_veiculo VARCHAR(30) NOT NULL,
  capacidade_kg NUMERIC(10,2),
  status VARCHAR(20) NOT NULL DEFAULT 'DISPONIVEL',
  crlv_validade DATE,
  seguro_validade DATE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, placa)
);

CREATE TABLE IF NOT EXISTS motoristas (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nome VARCHAR(150) NOT NULL,
  cpf VARCHAR(20),
  telefone VARCHAR(20),
  cnh_categoria VARCHAR(5),
  cnh_validade DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'DISPONIVEL',
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fretes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  numero SERIAL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  cliente_id UUID NOT NULL REFERENCES clientes(id),
  nome_solicitante VARCHAR(150),
  telefone VARCHAR(20),
  email VARCHAR(150),
  origem VARCHAR(100) NOT NULL,
  destino VARCHAR(100) NOT NULL,
  peso_kg NUMERIC(12,2) NOT NULL,
  tarifa_kg NUMERIC(10,2) NOT NULL,
  km NUMERIC(10,2) NOT NULL,
  tipo_veiculo VARCHAR(30) NOT NULL,
  valor_km NUMERIC(10,2) NOT NULL,
  custo_km NUMERIC(10,2) NOT NULL,
  valor_frete NUMERIC(12,2) NOT NULL,
  custo NUMERIC(12,2) NOT NULL,
  lucro NUMERIC(12,2) NOT NULL,
  margem NUMERIC(6,4) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'COTACAO_PRONTA',
  veiculo_id UUID REFERENCES veiculos(id),
  motorista_id UUID REFERENCES motoristas(id),
  data_coleta DATE,
  data_entrega_prevista DATE,
  data_entrega_real DATE,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fretes_tenant_status ON fretes(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_fretes_cliente ON fretes(cliente_id);
CREATE INDEX IF NOT EXISTS idx_fretes_criado_em ON fretes(criado_em);

CREATE TABLE IF NOT EXISTS financeiro_lancamentos (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tipo VARCHAR(10) NOT NULL,
  categoria VARCHAR(60) NOT NULL,
  frete_id UUID REFERENCES fretes(id),
  cliente_id UUID REFERENCES clientes(id),
  descricao VARCHAR(200),
  valor NUMERIC(12,2) NOT NULL,
  vencimento DATE NOT NULL,
  pago_em DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDENTE',
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_financeiro_tenant_status ON financeiro_lancamentos(tenant_id, status);

CREATE TABLE IF NOT EXISTS distancias_cache (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  origem VARCHAR(100) NOT NULL,
  destino VARCHAR(100) NOT NULL,
  km NUMERIC(10,2) NOT NULL,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (origem, destino)
);

CREATE TABLE IF NOT EXISTS sync_sheets_fila (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entidade_tipo VARCHAR(20) NOT NULL,
  entidade_id UUID NOT NULL,
  operacao VARCHAR(10) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDENTE',
  tentativas INT NOT NULL DEFAULT 0,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  processado_em TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sync_status ON sync_sheets_fila(status);

CREATE TABLE IF NOT EXISTS licencas (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  valor_entrada NUMERIC(10,2) NOT NULL DEFAULT 2000.00,
  valor_mensalidade NUMERIC(10,2) NOT NULL DEFAULT 49.99,
  data_inicio DATE NOT NULL DEFAULT CURRENT_DATE,
  proximo_vencimento DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PERIODO_INICIAL',
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS super_admins (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  nome VARCHAR(150) NOT NULL,
  email VARCHAR(150) NOT NULL UNIQUE,
  senha_hash VARCHAR(255) NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE VIEW vw_dashboard AS
SELECT
  tenant_id,
  COUNT(*) AS total_fretes,
  SUM(valor_frete) AS faturamento,
  SUM(custo) AS custos,
  SUM(lucro) AS lucro,
  AVG(margem) AS margem,
  COUNT(*) FILTER (WHERE status = 'APROVADO') AS qtd_aprovado,
  COUNT(*) FILTER (WHERE status = 'EM_TRANSPORTE') AS qtd_em_transporte,
  COUNT(*) FILTER (WHERE status = 'FINALIZADO') AS qtd_finalizado,
  COUNT(*) FILTER (WHERE status = 'PENDENTE') AS qtd_pendente,
  COUNT(*) FILTER (WHERE status = 'CANCELADO') AS qtd_cancelado,
  COUNT(*) FILTER (WHERE status = 'COTACAO_PRONTA') AS qtd_cotacao_pronta
FROM fretes GROUP BY tenant_id;

CREATE OR REPLACE VIEW vw_clientes_resumo AS
SELECT
  c.id AS cliente_id, c.tenant_id, c.empresa,
  COUNT(f.id) AS total_fretes,
  COALESCE(SUM(f.valor_frete), 0) AS faturamento,
  COALESCE(SUM(f.lucro), 0) AS lucro,
  CASE WHEN SUM(f.valor_frete) > 0 THEN ROUND(SUM(f.lucro) / SUM(f.valor_frete), 4) ELSE 0 END AS margem,
  MAX(f.criado_em) AS ultimo_frete
FROM clientes c LEFT JOIN fretes f ON f.cliente_id = c.id
GROUP BY c.id, c.tenant_id, c.empresa;
`;

async function aplicarSchema() {
  const comandos = SCHEMA_SQL.split(";").map((c) => c.trim()).filter(Boolean);
  for (const comando of comandos) {
    try {
      await pool.query(comando);
    } catch (err) {
      console.error("Aviso ao aplicar schema (pode ser normal se já existir):", err.message);
    }
  }
  console.log("Schema verificado/aplicado com sucesso.");
}

// =======================================================================
// 2. LÓGICA DE NEGÓCIO — idêntica à planilha original
// =======================================================================
async function buscarTarifas(tenantId) {
  const { rows } = await pool.query(
    `SELECT peso_inicial, peso_final, valor_por_kg FROM tarifas_peso WHERE tenant_id = $1 AND ativo = true ORDER BY peso_inicial ASC`,
    [tenantId]
  );
  return rows;
}
async function buscarVeiculos(tenantId) {
  const { rows } = await pool.query(
    `SELECT v.tipo_veiculo, v.valor_por_km, v.peso_maximo_kg, c.custo_por_km
     FROM valor_km_veiculo v JOIN custo_km_veiculo c ON c.tenant_id = v.tenant_id AND c.tipo_veiculo = v.tipo_veiculo
     WHERE v.tenant_id = $1 ORDER BY v.peso_maximo_kg ASC`,
    [tenantId]
  );
  return rows;
}
function tarifaPorPeso(tarifas, peso) {
  const faixa = tarifas.find((f) => peso >= f.peso_inicial && peso <= f.peso_final);
  if (!faixa) throw new Error("Nenhuma faixa de tarifa cadastrada cobre esse peso");
  return Number(faixa.valor_por_kg);
}
function veiculoPorPeso(veiculos, peso) {
  const veiculo = veiculos.find((v) => peso <= v.peso_maximo_kg);
  if (!veiculo) throw new Error("Nenhum veículo cadastrado suporta esse peso");
  return veiculo;
}
function round2(v) { return Math.round(v * 100) / 100; }
function calcular({ peso, km, tarifa, valorKm, custoKm }) {
  const valorFrete = peso * tarifa + km * valorKm;
  const custo = km * custoKm;
  const lucro = valorFrete - custo;
  const margem = valorFrete > 0 ? lucro / valorFrete : 0;
  return { valorFrete: round2(valorFrete), custo: round2(custo), lucro: round2(lucro), margem: Number(margem.toFixed(4)) };
}

// Substitui a função =KM() do Apps Script. Com GOOGLE_MAPS_API_KEY
// configurada, usa distância real; sem ela, usa um cálculo simulado
// (só pra não travar antes de você configurar a chave).
async function calcularDistanciaKm(origem, destino) {
  const origemNorm = origem.trim().toLowerCase();
  const destinoNorm = destino.trim().toLowerCase();

  const cache = await pool.query(`SELECT km FROM distancias_cache WHERE origem = $1 AND destino = $2`, [origemNorm, destinoNorm]);
  if (cache.rows.length > 0) return Number(cache.rows[0].km);

  let km;
  if (process.env.GOOGLE_MAPS_API_KEY) {
    const url = new URL("https://maps.googleapis.com/maps/api/distancematrix/json");
    url.searchParams.set("origins", origem);
    url.searchParams.set("destinations", destino);
    url.searchParams.set("units", "metric");
    url.searchParams.set("key", process.env.GOOGLE_MAPS_API_KEY);
    const resp = await fetch(url.toString());
    const data = await resp.json();
    const elemento = data?.rows?.[0]?.elements?.[0];
    if (!elemento || elemento.status !== "OK") throw new Error(`Não foi possível calcular a distância entre "${origem}" e "${destino}"`);
    km = Math.round(elemento.distance.value / 1000);
  } else {
    let hash = 0;
    const chave = `${origemNorm}|${destinoNorm}`;
    for (const c of chave) hash = (hash * 31 + c.charCodeAt(0)) % 1000;
    km = 150 + hash;
  }

  await pool.query(
    `INSERT INTO distancias_cache (origem, destino, km) VALUES ($1,$2,$3) ON CONFLICT (origem, destino) DO UPDATE SET km = EXCLUDED.km, atualizado_em = now()`,
    [origemNorm, destinoNorm, km]
  );
  return km;
}

// =======================================================================
// 3. GOOGLE SHEETS — espelho automático (opcional, roda só se configurado)
// =======================================================================
async function enfileirarSync(tenantId, entidadeTipo, entidadeId, operacao) {
  await pool.query(
    `INSERT INTO sync_sheets_fila (tenant_id, entidade_tipo, entidade_id, operacao) VALUES ($1,$2,$3,$4)`,
    [tenantId, entidadeTipo, entidadeId, operacao]
  );
}
async function processarFilaSync() {
  if (!process.env.GOOGLE_SHEETS_SPREADSHEET_ID || !process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL) return;
  const { google } = require("googleapis");
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, null,
    (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  const sheets = google.sheets({ version: "v4", auth });

  const { rows } = await pool.query(`SELECT * FROM sync_sheets_fila WHERE status = 'PENDENTE' ORDER BY criado_em ASC LIMIT 20`);
  for (const item of rows) {
    try {
      if (item.entidade_tipo === "FRETE") {
        const f = (await pool.query(`SELECT f.*, c.empresa FROM fretes f JOIN clientes c ON c.id = f.cliente_id WHERE f.id = $1`, [item.entidade_id])).rows[0];
        if (f) {
          await sheets.spreadsheets.values.append({
            spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID, range: "BETA V3!A:R", valueInputOption: "USER_ENTERED",
            requestBody: { values: [[f.criado_em, f.numero, f.empresa, f.nome_solicitante, f.telefone, f.email, f.origem, f.destino, f.peso_kg, f.tarifa_kg, f.km, f.tipo_veiculo, f.valor_km, f.valor_frete, f.custo, f.lucro, f.margem, f.status]] },
          });
        }
      } else if (item.entidade_tipo === "CLIENTE") {
        const c = (await pool.query(`SELECT * FROM clientes WHERE id = $1`, [item.entidade_id])).rows[0];
        if (c) {
          await sheets.spreadsheets.values.append({
            spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID, range: "CLIENTES!A:E", valueInputOption: "USER_ENTERED",
            requestBody: { values: [[c.empresa, c.contato_nome, c.telefone, c.email, c.cidade]] },
          });
        }
      }
      await pool.query(`UPDATE sync_sheets_fila SET status = 'SINCRONIZADO', processado_em = now() WHERE id = $1`, [item.id]);
    } catch (err) {
      console.error(`Erro ao sincronizar ${item.entidade_tipo} ${item.entidade_id}:`, err.message);
      await pool.query(`UPDATE sync_sheets_fila SET status = 'ERRO', tentativas = tentativas + 1 WHERE id = $1`, [item.id]);
    }
  }
}

// =======================================================================
// 4. AUTENTICAÇÃO E MIDDLEWARES
// =======================================================================
function autenticar(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ erro: "Token não informado" });
  try {
    req.usuario = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ erro: "Token inválido ou expirado" });
  }
}
function permitir(...papeis) {
  return (req, res, next) => {
    if (!papeis.includes(req.usuario.papel)) return res.status(403).json({ erro: "Você não tem permissão para esta ação" });
    next();
  };
}
function autenticarAdmin(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ erro: "Token não informado" });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.tipo !== "SUPER_ADMIN") return res.status(403).json({ erro: "Acesso restrito ao administrador do sistema" });
    req.admin = payload;
    next();
  } catch (err) {
    return res.status(401).json({ erro: "Token inválido ou expirado" });
  }
}
const DIAS_TOLERANCIA = 5;
async function verificarLicenca(req, res, next) {
  if (req.method === "GET") return next();
  const { rows } = await pool.query(`SELECT status, proximo_vencimento FROM licencas WHERE tenant_id = $1`, [req.usuario.tenant_id]);
  if (rows.length === 0) return next();
  const licenca = rows[0];
  const diasAtraso = Math.round((Date.now() - new Date(licenca.proximo_vencimento)) / 86400000);
  if (licenca.status === "INADIMPLENTE" && diasAtraso > DIAS_TOLERANCIA) {
    return res.status(402).json({ erro: "LICENCA_VENCIDA", mensagem: `Licença vencida há ${diasAtraso} dias. Regularize o pagamento para continuar criando ou editando registros.`, diasAtraso });
  }
  next();
}
function validar(schema) {
  return (req, res, next) => {
    const resultado = schema.safeParse(req.body);
    if (!resultado.success) {
      const primeiro = resultado.error.issues[0];
      return res.status(400).json({ erro: "DADOS_INVALIDOS", mensagem: `${primeiro.path.join(".")}: ${primeiro.message}` });
    }
    req.body = resultado.data;
    next();
  };
}

// =======================================================================
// 5. SCHEMAS DE VALIDAÇÃO
// =======================================================================
const registrarTenantSchema = z.object({
  razaoSocial: z.string().min(2, "informe a razão social"),
  cnpj: z.string().optional(),
  nomeDono: z.string().min(2, "informe o nome do responsável"),
  emailDono: z.string().email("e-mail inválido"),
  senha: z.string().min(8, "a senha precisa ter pelo menos 8 caracteres"),
});
const loginSchema = z.object({ email: z.string().email("e-mail inválido"), senha: z.string().min(1, "informe a senha") });
const clienteSchema = z.object({
  empresa: z.string().min(2, "informe o nome da empresa"), cnpj: z.string().optional(), contatoNome: z.string().optional(),
  telefone: z.string().optional(), email: z.string().email("e-mail inválido").optional().or(z.literal("")), cidade: z.string().optional(),
  condicaoPagamento: z.string().optional(),
});
const cotarSchema = z.object({
  peso: z.number({ invalid_type_error: "peso deve ser um número" }).positive("peso deve ser maior que zero"),
  origem: z.string().min(2, "informe a cidade de origem"), destino: z.string().min(2, "informe a cidade de destino"),
});
const freteSchema = z.object({
  clienteId: z.string().uuid("clienteId inválido"), nome: z.string().optional(), telefone: z.string().optional(),
  email: z.string().email("e-mail inválido").optional().or(z.literal("")),
  origem: z.string().min(2, "informe a cidade de origem"), destino: z.string().min(2, "informe a cidade de destino"),
  peso: z.number().positive("peso deve ser maior que zero"),
});

// =======================================================================
// 6. APP EXPRESS
// =======================================================================
const app = express();
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));
app.use(express.json());
app.use(rateLimit({ windowMs: 60 * 1000, max: 200 }));
const limiteLogin = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { erro: "MUITAS_TENTATIVAS", mensagem: "Muitas tentativas de login. Aguarde alguns minutos." } });

app.get("/health", (req, res) => res.json({ status: "ok" }));

// --- Autenticação (rotas públicas) ---
app.post("/auth/login", limiteLogin, validar(loginSchema), async (req, res) => {
  const { email, senha } = req.body;
  const { rows } = await pool.query(`SELECT id, tenant_id, nome, senha_hash, papel, ativo FROM usuarios WHERE email = $1`, [email]);
  const usuario = rows[0];
  if (!usuario || !usuario.ativo || !(await bcrypt.compare(senha, usuario.senha_hash))) {
    return res.status(401).json({ erro: "E-mail ou senha inválidos" });
  }
  const token = jwt.sign({ id: usuario.id, tenant_id: usuario.tenant_id, papel: usuario.papel, email }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || "8h" });
  res.json({ token, usuario: { id: usuario.id, nome: usuario.nome, papel: usuario.papel } });
});

app.post("/auth/registrar-tenant", validar(registrarTenantSchema), async (req, res) => {
  const { razaoSocial, cnpj, nomeDono, emailDono, senha } = req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tenant = await client.query(`INSERT INTO tenants (razao_social, cnpj) VALUES ($1,$2) RETURNING id`, [razaoSocial, cnpj || null]);
    const tenantId = tenant.rows[0].id;
    const senhaHash = await bcrypt.hash(senha, 10);
    await client.query(`INSERT INTO usuarios (tenant_id, nome, email, senha_hash, papel) VALUES ($1,$2,$3,$4,'DONO')`, [tenantId, nomeDono, emailDono, senhaHash]);
    const proximoVenc = new Date();
    proximoVenc.setMonth(proximoVenc.getMonth() + 1);
    await client.query(`INSERT INTO licencas (tenant_id, proximo_vencimento, status) VALUES ($1,$2,'PERIODO_INICIAL')`, [tenantId, proximoVenc]);
    await client.query(
      `INSERT INTO tarifas_peso (tenant_id, peso_inicial, peso_final, valor_por_kg, observacao) VALUES
       ($1,0,100,1.20,'Até 100kg'),($1,101,500,0.90,'101 a 500kg'),($1,501,1500,0.70,'501 a 1.500kg'),
       ($1,1501,6000,0.50,'1.501 a 6.000kg'),($1,6001,30000,0.35,'6.001 a 30.000kg')`, [tenantId]
    );
    await client.query(`INSERT INTO valor_km_veiculo (tenant_id, tipo_veiculo, valor_por_km, peso_maximo_kg) VALUES ($1,'VAN',3.5,500),($1,'VUC',4.5,1500),($1,'TRUCK',5.5,6000),($1,'CARRETA',6.5,30000)`, [tenantId]);
    await client.query(`INSERT INTO custo_km_veiculo (tenant_id, tipo_veiculo, custo_por_km) VALUES ($1,'VAN',2.5),($1,'VUC',3.5),($1,'TRUCK',4.5),($1,'CARRETA',5.5)`, [tenantId]);
    await client.query("COMMIT");
    res.status(201).json({ tenantId, mensagem: "Transportadora cadastrada com sucesso" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ erro: "Não foi possível cadastrar a transportadora" });
  } finally {
    client.release();
  }
});

// --- Autenticação do super-admin (separada, só pra você) ---
app.post("/admin/auth/setup-inicial", async (req, res) => {
  const { nome, email, senha, setupToken } = req.body;
  if (setupToken !== process.env.ADMIN_SETUP_TOKEN) return res.status(403).json({ erro: "setupToken inválido" });
  const existe = await pool.query(`SELECT id FROM super_admins LIMIT 1`);
  if (existe.rows.length > 0) return res.status(409).json({ erro: "Já existe um super-admin cadastrado" });
  const senhaHash = await bcrypt.hash(senha, 10);
  const { rows } = await pool.query(`INSERT INTO super_admins (nome, email, senha_hash) VALUES ($1,$2,$3) RETURNING id`, [nome, email, senhaHash]);
  res.status(201).json({ id: rows[0].id });
});
app.post("/admin/auth/login", limiteLogin, async (req, res) => {
  const { email, senha } = req.body;
  const { rows } = await pool.query(`SELECT * FROM super_admins WHERE email = $1`, [email]);
  const admin = rows[0];
  if (!admin || !(await bcrypt.compare(senha, admin.senha_hash))) return res.status(401).json({ erro: "E-mail ou senha inválidos" });
  const token = jwt.sign({ id: admin.id, tipo: "SUPER_ADMIN" }, process.env.JWT_SECRET, { expiresIn: "8h" });
  res.json({ token, nome: admin.nome });
});

// A partir daqui, tudo exige login de transportadora.
app.use(autenticar);
app.use(verificarLicenca);

// --- Clientes ---
app.get("/clientes", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.*, COUNT(f.id) AS total_fretes, COALESCE(SUM(f.valor_frete),0) AS faturamento, COALESCE(SUM(f.lucro),0) AS lucro
     FROM clientes c LEFT JOIN fretes f ON f.cliente_id = c.id WHERE c.tenant_id = $1 GROUP BY c.id ORDER BY faturamento DESC`,
    [req.usuario.tenant_id]
  );
  res.json(rows);
});
app.post("/clientes", validar(clienteSchema), async (req, res) => {
  const { empresa, cnpj, contatoNome, telefone, email, cidade, condicaoPagamento } = req.body;
  const { rows } = await pool.query(
    `INSERT INTO clientes (tenant_id, empresa, cnpj, contato_nome, telefone, email, cidade, condicao_pagamento) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [req.usuario.tenant_id, empresa, cnpj, contatoNome, telefone, email, cidade, condicaoPagamento || "A vista"]
  );
  await enfileirarSync(req.usuario.tenant_id, "CLIENTE", rows[0].id, "INSERT");
  res.status(201).json(rows[0]);
});

// --- Fretes / Cotação ---
app.post("/fretes/cotar", validar(cotarSchema), async (req, res) => {
  const { peso, origem, destino } = req.body;
  try {
    const [tarifas, veiculos, km] = await Promise.all([buscarTarifas(req.usuario.tenant_id), buscarVeiculos(req.usuario.tenant_id), calcularDistanciaKm(origem, destino)]);
    const tarifa = tarifaPorPeso(tarifas, peso);
    const veiculo = veiculoPorPeso(veiculos, peso);
    const resultado = calcular({ peso, km, tarifa, valorKm: Number(veiculo.valor_por_km), custoKm: Number(veiculo.custo_por_km) });
    res.json({ km, tarifa, veiculo: veiculo.tipo_veiculo, valorKm: Number(veiculo.valor_por_km), ...resultado });
  } catch (err) {
    res.status(422).json({ erro: err.message });
  }
});
app.post("/fretes", validar(freteSchema), async (req, res) => {
  const tenantId = req.usuario.tenant_id;
  const { clienteId, nome, telefone, email, origem, destino, peso } = req.body;
  try {
    const [tarifas, veiculos, km] = await Promise.all([buscarTarifas(tenantId), buscarVeiculos(tenantId), calcularDistanciaKm(origem, destino)]);
    const tarifa = tarifaPorPeso(tarifas, peso);
    const veiculo = veiculoPorPeso(veiculos, peso);
    const r = calcular({ peso, km, tarifa, valorKm: Number(veiculo.valor_por_km), custoKm: Number(veiculo.custo_por_km) });
    const { rows } = await pool.query(
      `INSERT INTO fretes (tenant_id, cliente_id, nome_solicitante, telefone, email, origem, destino, peso_kg, tarifa_kg, km, tipo_veiculo, valor_km, custo_km, valor_frete, custo, lucro, margem, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'COTACAO_PRONTA') RETURNING *`,
      [tenantId, clienteId, nome, telefone, email, origem, destino, peso, tarifa, km, veiculo.tipo_veiculo, veiculo.valor_por_km, veiculo.custo_por_km, r.valorFrete, r.custo, r.lucro, r.margem]
    );
    await enfileirarSync(tenantId, "FRETE", rows[0].id, "INSERT");
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(422).json({ erro: err.message });
  }
});
app.get("/fretes", async (req, res) => {
  const { status, clienteId, de, ate } = req.query;
  const condicoes = ["f.tenant_id = $1"];
  const valores = [req.usuario.tenant_id];
  if (status) { valores.push(status); condicoes.push(`f.status = $${valores.length}`); }
  if (clienteId) { valores.push(clienteId); condicoes.push(`f.cliente_id = $${valores.length}`); }
  if (de) { valores.push(de); condicoes.push(`f.criado_em >= $${valores.length}`); }
  if (ate) { valores.push(ate); condicoes.push(`f.criado_em <= $${valores.length}`); }
  const { rows } = await pool.query(`SELECT f.*, c.empresa FROM fretes f JOIN clientes c ON c.id = f.cliente_id WHERE ${condicoes.join(" AND ")} ORDER BY f.criado_em DESC LIMIT 200`, valores);
  res.json(rows);
});
app.patch("/fretes/:id/status", async (req, res) => {
  const { status } = req.body;
  const validos = ["COTACAO_PRONTA", "APROVADO", "EM_TRANSPORTE", "FINALIZADO", "PENDENTE", "CANCELADO"];
  if (!validos.includes(status)) return res.status(400).json({ erro: "Status inválido" });
  const { rows } = await pool.query(`UPDATE fretes SET status = $1, atualizado_em = now() WHERE id = $2 AND tenant_id = $3 RETURNING *`, [status, req.params.id, req.usuario.tenant_id]);
  if (rows.length === 0) return res.status(404).json({ erro: "Frete não encontrado" });
  await enfileirarSync(req.usuario.tenant_id, "FRETE", req.params.id, "UPDATE");
  res.json(rows[0]);
});

// --- Configuração de tarifas (só DONO) ---
app.get("/config/tarifas", permitir("DONO"), async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM tarifas_peso WHERE tenant_id = $1 ORDER BY peso_inicial`, [req.usuario.tenant_id]);
  res.json(rows);
});
app.put("/config/tarifas/:id", permitir("DONO"), async (req, res) => {
  const { valorPorKg } = req.body;
  const { rows } = await pool.query(`UPDATE tarifas_peso SET valor_por_kg = $1 WHERE id = $2 AND tenant_id = $3 RETURNING *`, [valorPorKg, req.params.id, req.usuario.tenant_id]);
  if (rows.length === 0) return res.status(404).json({ erro: "Faixa não encontrada" });
  res.json(rows[0]);
});
app.get("/config/veiculos-tarifa", permitir("DONO"), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT v.id, v.tipo_veiculo, v.valor_por_km, v.peso_maximo_kg, c.custo_por_km FROM valor_km_veiculo v
     JOIN custo_km_veiculo c ON c.tenant_id = v.tenant_id AND c.tipo_veiculo = v.tipo_veiculo WHERE v.tenant_id = $1 ORDER BY v.peso_maximo_kg`,
    [req.usuario.tenant_id]
  );
  res.json(rows);
});
app.put("/config/veiculos-tarifa/:tipoVeiculo", permitir("DONO"), async (req, res) => {
  const { valorPorKm, custoPorKm } = req.body;
  const tenantId = req.usuario.tenant_id, tipo = req.params.tipoVeiculo;
  if (valorPorKm != null) await pool.query(`UPDATE valor_km_veiculo SET valor_por_km = $1 WHERE tenant_id = $2 AND tipo_veiculo = $3`, [valorPorKm, tenantId, tipo]);
  if (custoPorKm != null) await pool.query(`UPDATE custo_km_veiculo SET custo_por_km = $1 WHERE tenant_id = $2 AND tipo_veiculo = $3`, [custoPorKm, tenantId, tipo]);
  res.json({ mensagem: "Atualizado" });
});

// --- Frota ---
app.get("/frota/veiculos", async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM veiculos WHERE tenant_id = $1 ORDER BY placa`, [req.usuario.tenant_id]);
  res.json(rows);
});
app.post("/frota/veiculos", async (req, res) => {
  const { placa, tipoVeiculo, capacidadeKg, crlvValidade, seguroValidade } = req.body;
  if (!placa || !tipoVeiculo) return res.status(400).json({ erro: "placa e tipoVeiculo são obrigatórios" });
  const { rows } = await pool.query(`INSERT INTO veiculos (tenant_id, placa, tipo_veiculo, capacidade_kg, crlv_validade, seguro_validade) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [req.usuario.tenant_id, placa, tipoVeiculo, capacidadeKg, crlvValidade, seguroValidade]);
  res.status(201).json(rows[0]);
});
app.patch("/frota/veiculos/:id/status", async (req, res) => {
  const { rows } = await pool.query(`UPDATE veiculos SET status = $1 WHERE id = $2 AND tenant_id = $3 RETURNING *`, [req.body.status, req.params.id, req.usuario.tenant_id]);
  if (rows.length === 0) return res.status(404).json({ erro: "Veículo não encontrado" });
  res.json(rows[0]);
});
app.get("/frota/motoristas", async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM motoristas WHERE tenant_id = $1 ORDER BY nome`, [req.usuario.tenant_id]);
  res.json(rows);
});
app.post("/frota/motoristas", async (req, res) => {
  const { nome, cpf, telefone, cnhCategoria, cnhValidade } = req.body;
  if (!nome) return res.status(400).json({ erro: "nome é obrigatório" });
  const { rows } = await pool.query(`INSERT INTO motoristas (tenant_id, nome, cpf, telefone, cnh_categoria, cnh_validade) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [req.usuario.tenant_id, nome, cpf, telefone, cnhCategoria, cnhValidade]);
  res.status(201).json(rows[0]);
});
app.get("/frota/alertas-documentos", async (req, res) => {
  const tenantId = req.usuario.tenant_id;
  const veiculos = await pool.query(
    `SELECT placa AS identificacao, 'CRLV' AS documento, crlv_validade AS validade FROM veiculos WHERE tenant_id=$1 AND crlv_validade <= CURRENT_DATE + INTERVAL '30 days'
     UNION ALL SELECT placa, 'Seguro', seguro_validade FROM veiculos WHERE tenant_id=$1 AND seguro_validade <= CURRENT_DATE + INTERVAL '30 days'`,
    [tenantId]
  );
  const motoristas = await pool.query(`SELECT nome AS identificacao, 'CNH' AS documento, cnh_validade AS validade FROM motoristas WHERE tenant_id=$1 AND cnh_validade <= CURRENT_DATE + INTERVAL '30 days'`, [tenantId]);
  res.json([...veiculos.rows, ...motoristas.rows]);
});

// --- Financeiro ---
app.get("/financeiro", async (req, res) => {
  const { status, tipo } = req.query;
  const condicoes = ["tenant_id = $1"];
  const valores = [req.usuario.tenant_id];
  if (status) { valores.push(status); condicoes.push(`status = $${valores.length}`); }
  if (tipo) { valores.push(tipo); condicoes.push(`tipo = $${valores.length}`); }
  const { rows } = await pool.query(`SELECT * FROM financeiro_lancamentos WHERE ${condicoes.join(" AND ")} ORDER BY vencimento ASC`, valores);
  res.json(rows);
});
app.post("/financeiro", async (req, res) => {
  const { tipo, categoria, freteId, clienteId, descricao, valor, vencimento } = req.body;
  if (!tipo || !categoria || !valor || !vencimento) return res.status(400).json({ erro: "tipo, categoria, valor e vencimento são obrigatórios" });
  const { rows } = await pool.query(`INSERT INTO financeiro_lancamentos (tenant_id, tipo, categoria, frete_id, cliente_id, descricao, valor, vencimento) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [req.usuario.tenant_id, tipo, categoria, freteId || null, clienteId || null, descricao, valor, vencimento]);
  res.status(201).json(rows[0]);
});
app.patch("/financeiro/:id/baixar", async (req, res) => {
  const { rows } = await pool.query(`UPDATE financeiro_lancamentos SET status='PAGO', pago_em=CURRENT_DATE WHERE id=$1 AND tenant_id=$2 RETURNING *`, [req.params.id, req.usuario.tenant_id]);
  if (rows.length === 0) return res.status(404).json({ erro: "Lançamento não encontrado" });
  res.json(rows[0]);
});
app.post("/financeiro/marcar-vencidos", async (req, res) => {
  const { rowCount } = await pool.query(`UPDATE financeiro_lancamentos SET status='VENCIDO' WHERE tenant_id=$1 AND status='PENDENTE' AND vencimento < CURRENT_DATE`, [req.usuario.tenant_id]);
  res.json({ atualizados: rowCount });
});

// --- Dashboard ---
app.get("/dashboard", async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM vw_dashboard WHERE tenant_id = $1`, [req.usuario.tenant_id]);
  res.json(rows[0] || { total_fretes: 0, faturamento: 0, custos: 0, lucro: 0, margem: 0, qtd_aprovado: 0, qtd_em_transporte: 0, qtd_finalizado: 0, qtd_pendente: 0, qtd_cancelado: 0, qtd_cotacao_pronta: 0 });
});
app.get("/dashboard/clientes", async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM vw_clientes_resumo WHERE tenant_id = $1 ORDER BY faturamento DESC`, [req.usuario.tenant_id]);
  res.json(rows);
});

// --- Licenças (painel interno seu, login separado) ---
app.get("/licencas", autenticarAdmin, async (req, res) => {
  const { rows } = await pool.query(`SELECT l.*, t.razao_social FROM licencas l JOIN tenants t ON t.id = l.tenant_id ORDER BY l.proximo_vencimento ASC`);
  res.json(rows);
});
app.patch("/licencas/:tenantId/registrar-pagamento", autenticarAdmin, async (req, res) => {
  const { rows } = await pool.query(`UPDATE licencas SET status='ATIVA', proximo_vencimento = proximo_vencimento + INTERVAL '1 month', atualizado_em = now() WHERE tenant_id = $1 RETURNING *`, [req.params.tenantId]);
  if (rows.length === 0) return res.status(404).json({ erro: "Licença não encontrada" });
  res.json(rows[0]);
});
app.patch("/licencas/:tenantId/status", autenticarAdmin, async (req, res) => {
  const { rows } = await pool.query(`UPDATE licencas SET status = $1, atualizado_em = now() WHERE tenant_id = $2 RETURNING *`, [req.body.status, req.params.tenantId]);
  if (rows.length === 0) return res.status(404).json({ erro: "Licença não encontrada" });
  res.json(rows[0]);
});

// --- 404 e erro genérico ---
app.use((req, res) => res.status(404).json({ erro: "ROTA_NAO_ENCONTRADA", mensagem: `${req.method} ${req.path} não existe` }));
app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] Erro em ${req.method} ${req.path}:`, err);
  res.status(500).json({ erro: "ERRO_INTERNO", mensagem: "Algo deu errado no servidor. Tente novamente." });
});

// =======================================================================
// 7. SUBIR O SERVIDOR
// =======================================================================
const PORT = process.env.PORT || 3000;
aplicarSchema().finally(() => {
  app.listen(PORT, () => {
    console.log(`API ÁPEX rodando na porta ${PORT}`);
    const intervalo = Number(process.env.SYNC_INTERVAL_MS || 15000);
    setInterval(() => { processarFilaSync().catch((err) => console.error("Erro no worker de sync:", err)); }, intervalo);
  });
});
