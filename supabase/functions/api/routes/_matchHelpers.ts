import OpenAI from 'https://esm.sh/openai@4'

// ── Access helpers ────────────────────────────────────────────────────────────
export function checkAccess(user: any): boolean {
  return user?.app_metadata?.is_admin === true || user?.app_metadata?.role === 'recruiters'
}

export function hasPrivacyAccess(privacyArray: any, viewerRole: string): boolean {
  if (!privacyArray || !Array.isArray(privacyArray)) return false
  return privacyArray.includes(viewerRole)
}

export function stripHtml(html: string): string {
  return (html ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

// ── Embedding ─────────────────────────────────────────────────────────────────
export async function getEmbedding(text: string): Promise<number[]> {
  const openai = new OpenAI({ apiKey: Deno.env.get('TEST_OPENAI_API_KEY') })
  const result = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text.slice(0, 6000),
  })
  return result.data[0].embedding
}

// ── Skill extraction (categorized) ───────────────────────────────────────────
export interface CategorizedSkills {
  required: string[]
  preferred: string[]
  nice_to_have: string[]
  required_experience_years: number | null
}

export async function extractSkillsFromJd(jdText: string): Promise<CategorizedSkills> {
  const empty: CategorizedSkills = { required: [], preferred: [], nice_to_have: [], required_experience_years: null }
  try {
    const openai = new OpenAI({ apiKey: Deno.env.get('TEST_OPENAI_API_KEY') })
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            'Extract technical and professional skills from the job description, categorized by importance. ' +
            'Return ONLY the bare skill name — no qualifiers like "developer", "engineer", "programming", "framework", "experience", "proficiency". ' +
            'Good: "React", "Python", "Machine Learning". Bad: "React Developer", "Python Programming". ' +
            'Also extract the minimum years of experience required (null if not specified). ' +
            'Return JSON: {"required": ["Python","SQL"], "preferred": ["Docker"], "nice_to_have": ["Excel"], "required_experience_years": 3}',
        },
        { role: 'user', content: jdText.slice(0, 4000) },
      ],
      response_format: { type: 'json_object' },
    })
    const parsed = JSON.parse(res.choices[0].message.content ?? '{}')
    return {
      required: Array.isArray(parsed.required) ? parsed.required : [],
      preferred: Array.isArray(parsed.preferred) ? parsed.preferred : [],
      nice_to_have: Array.isArray(parsed.nice_to_have) ? parsed.nice_to_have : [],
      required_experience_years: typeof parsed.required_experience_years === 'number'
        ? parsed.required_experience_years
        : null,
    }
  } catch {
    return empty
  }
}

// ── Skill normalisation ───────────────────────────────────────────────────────
// Phase 1: language names that contain symbols — handled before any regex stripping
export const SYMBOL_LANGS: Record<string, string> = {
  'c++': 'cpp', 'c plus plus': 'cpp', 'cplusplus': 'cpp', 'c plusplus': 'cpp',
  'c#': 'csharp', 'c sharp': 'csharp',
  'f#': 'fsharp', 'f sharp': 'fsharp',
  '.net': 'dotnet', 'dot net': 'dotnet',
}

// Phase 2: separator-stripped, lowercased string → canonical form
export const SKILL_ALIASES: Record<string, string> = {
  // ── Programming Languages ──────────────────────────────────────────
  'js': 'javascript',  'ecmascript': 'javascript', 'es6': 'javascript',
  'es2015': 'javascript', 'es2016': 'javascript', 'es2017': 'javascript', 'es2018': 'javascript',
  'ts': 'typescript',
  'py': 'python',      'python3': 'python', 'python2': 'python',
  'rb': 'ruby',
  'golang': 'go',
  'vbnet': 'visualbasic', 'visualbasicnet': 'visualbasic', 'vba': 'visualbasic',
  'asm': 'assembly',   'assemblylanguage': 'assembly',
  'sh': 'bash',        'shell': 'bash',  'shellscript': 'bash', 'shellscripting': 'bash', 'bashscripting': 'bash',
  'ps1': 'powershell', 'posh': 'powershell',
  'objc': 'objectivec',
  'rs': 'rust',
  'sol': 'solidity',
  'kt': 'kotlin',
  'clj': 'clojure',   'cljs': 'clojurescript',
  'erl': 'erlang',
  'ex': 'elixir',     'exs': 'elixir',
  'hs': 'haskell',
  'ml': 'machinelearning',
  'abap': 'abap',

  // ── Frontend Frameworks & Libraries ───────────────────────────────
  'reactjs': 'react',
  'nextjs': 'next',
  'nuxtjs': 'nuxt',
  'vuejs': 'vue',      'vue2': 'vue', 'vue3': 'vue',
  'angularjs': 'angular', 'angular2': 'angular', 'angular4': 'angular',
  'solidjs': 'solid',
  'sveltekit': 'svelte',
  'emberjs': 'ember',
  'backbonejs': 'backbone',
  'alpinejs': 'alpine',
  'gatsbyjs': 'gatsby',
  'remixjs': 'remix',
  'astrojs': 'astro',
  'preactjs': 'preact',
  'litjs': 'lit',      'litelement': 'lit',
  'stenciljs': 'stencil',
  'qwikjs': 'qwik',

  // ── Backend Frameworks ─────────────────────────────────────────────
  'nodejs': 'node',
  'expressjs': 'express',
  'koajs': 'koa',
  'fastifyjs': 'fastify',
  'nestjs': 'nest',
  'hapijs': 'hapi',
  'ror': 'rubyonrails',  'rails': 'rubyonrails',
  'springboot': 'spring', 'springframework': 'spring',
  'aspnet': 'aspnet',    'aspnetcore': 'aspnet',
  'ginframework': 'gin',
  'fiberframework': 'fiber',
  'echoframework': 'echo',
  'actixweb': 'actix',

  // ── Databases ──────────────────────────────────────────────────────
  'mongo': 'mongodb',
  'postgres': 'postgresql', 'psql': 'postgresql', 'pg': 'postgresql', 'pgsql': 'postgresql',
  'mssql': 'sqlserver',     'microsoftsqlserver': 'sqlserver', 'sqlserverdb': 'sqlserver',
  'oracledb': 'oracle',     'oracledatabase': 'oracle',
  'elastic': 'elasticsearch', 'elasticsearchdb': 'elasticsearch',
  'dynamo': 'dynamodb',
  'influx': 'influxdb',
  'couch': 'couchdb',
  'arango': 'arangodb',
  'neo': 'neo4j',
  'fauna': 'fauna',
  'planetscale': 'planetscale',
  'neondb': 'neon',

  // ── Cloud Providers ────────────────────────────────────────────────
  'aws': 'amazonwebservices',  'amazonwebservices': 'amazonwebservices', 'amazon': 'amazonwebservices',
  'gcp': 'googlecloud',        'googlecloudplatform': 'googlecloud', 'gcloud': 'googlecloud',
  'azure': 'microsoftazure',   'msazure': 'microsoftazure', 'azurecloud': 'microsoftazure',
  'oci': 'oraclecloud',        'oraclecloudinfrastructure': 'oraclecloud',
  'ibmcloud': 'ibmcloud',
  'digitalocean': 'digitalocean',

  // ── DevOps, CI/CD & Infrastructure ────────────────────────────────
  'k8s': 'kubernetes',   'kube': 'kubernetes',
  'tf': 'terraform',
  'iac': 'infrastructureascode',
  'cicd': 'cicd',   'continuousintegration': 'cicd', 'continuousdeployment': 'cicd', 'continuousdelivery': 'cicd',
  'githubactions': 'githubactions', 'ghactions': 'githubactions',
  'gitlabci': 'gitlabci', 'gitlabcicd': 'gitlabci',
  'circleci': 'circleci',
  'travisci': 'travisci', 'travis': 'travisci',
  'argocd': 'argocd',  'argo': 'argocd',
  'elk': 'elkstack',   'elasticstack': 'elkstack',
  'vault': 'hashicorpvault', 'hashicorpvault': 'hashicorpvault',
  'helm': 'helm',
  'istio': 'istio',
  'prometheus': 'prometheus',
  'grafana': 'grafana',
  'datadog': 'datadog',
  'newrelic': 'newrelic',
  'splunk': 'splunk',
  'jenkins': 'jenkins',
  'ansible': 'ansible',
  'puppet': 'puppet',
  'chef': 'chef',
  'packer': 'packer',
  'traefik': 'traefik',
  'nginx': 'nginx',
  'haproxy': 'haproxy',
  'consul': 'consul',
  'nomad': 'hashicorpnomad',

  // ── AI / ML / Data Science & Engineering ──────────────────────────
  'machinelearning': 'machinelearning',
  'dl': 'deeplearning',        'deeplearning': 'deeplearning',
  'ai': 'artificialintelligence',
  'genai': 'generativeai',     'generativeai': 'generativeai',
  'llm': 'llm',  'llms': 'llm', 'largelanguagemodel': 'llm', 'largelanguagemodels': 'llm',
  'nlp': 'naturallanguageprocessing', 'naturallanguageprocessing': 'naturallanguageprocessing',
  'cv': 'computervision',      'computervision': 'computervision',
  'rl': 'reinforcementlearning',
  'gan': 'gan',  'gans': 'gan', 'generativeadversarialnetwork': 'gan',
  'cnn': 'cnn',  'cnns': 'cnn', 'convolutionalneuralnetwork': 'cnn',
  'rnn': 'rnn',  'rnns': 'rnn', 'recurrentneuralnetwork': 'rnn',
  'lstm': 'lstm',
  'bert': 'bert',
  'sklearn': 'scikitlearn', 'scikit': 'scikitlearn', 'scikitlearn': 'scikitlearn',
  'tensorflow': 'tensorflow',  'tflow': 'tensorflow',
  'torch': 'pytorch',
  'huggingface': 'huggingface', 'hf': 'huggingface',
  'langchain': 'langchain',
  'llamaindex': 'llamaindex',  'llama': 'llamaindex',
  'openaiapi': 'openai',
  'spark': 'apachespark',
  'kafka': 'apachekafka',
  'flink': 'apacheflink',
  'airflow': 'apacheairflow',
  'powerbi': 'powerbi',
  'tableau': 'tableau',
  'looker': 'looker',
  'metabase': 'metabase',
  'databricks': 'databricks',
  'mlops': 'mlops',
  'mlflow': 'mlflow',
  'kubeflow': 'kubeflow',
  'sagemaker': 'awssagemaker', 'awssagemaker': 'awssagemaker',
  'vertexai': 'googlevertexai',
  'jupyter': 'jupyter',        'jupyternotebook': 'jupyter',
  'colab': 'googlecolab',
  'dbt': 'dbt',
  'hadoop': 'hadoop',
  'hive': 'apachehive',
  'swagger': 'openapi',        'swaggerui': 'openapi',

  // ── Mobile Development ─────────────────────────────────────────────
  'rn': 'reactnative',
  'swiftui': 'swiftui',
  'jetpackcompose': 'jetpackcompose',
  'xamarin': 'xamarin',
  'ionic': 'ionic',
  'cordova': 'cordova',        'apachecordova': 'cordova',
  'capacitor': 'capacitor',
  'expo': 'expo',

  // ── Testing & QA ──────────────────────────────────────────────────
  'e2e': 'endtoend',  'endtoendtesting': 'endtoend',
  'tdd': 'testdrivendevelopment',
  'bdd': 'behaviordrivendevelopment',
  'rtl': 'reacttestinglibrary', 'reacttestinglibrary': 'reacttestinglibrary',
  'qa': 'qualityassurance',
  'sre': 'sitereliabilityengineering',

  // ── APIs & Protocols ───────────────────────────────────────────────
  'rest': 'restapi',   'restful': 'restapi',
  'gql': 'graphql',
  'ws': 'websockets',  'websocket': 'websockets',
  'grpc': 'grpc',
  'trpc': 'trpc',

  // ── Security ───────────────────────────────────────────────────────
  'oauth': 'oauth',    'oauth2': 'oauth', 'oauth20': 'oauth',
  'jwt': 'jwt',        'jsonwebtoken': 'jwt',
  'ssl': 'tls',        'ssltls': 'tls',
  'mfa': 'mfa',        '2fa': 'mfa', 'twofactorauthentication': 'mfa', 'multifactorauthentication': 'mfa',
  'sso': 'sso',        'singlesignon': 'sso',
  'iam': 'iam',        'identityandaccessmanagement': 'iam',
  'saml': 'saml',
  'pentest': 'penetrationtesting',  'pentesting': 'penetrationtesting',
  'infosec': 'cybersecurity',       'informationsecurity': 'cybersecurity',
  'devsecops': 'devsecops',
  'siem': 'siem',
  'owasp': 'owasp',
  'zerotrust': 'zerotrust',

  // ── Software Architecture & Design ─────────────────────────────────
  'ddd': 'domaindriven',  'domaindrivendesign': 'domaindriven',
  'cqrs': 'cqrs',
  'eda': 'eventdriven',   'eventdrivenarchitecture': 'eventdriven',
  'soa': 'serviceoriented',
  'oop': 'objectoriented',
  'fp': 'functionalprogramming',
  'mq': 'messagequeue',
  'pubsub': 'publishsubscribe',
  'bff': 'backendforfrontend',
  'mvc': 'mvc',
  'mvvm': 'mvvm',
  'solidprinciples': 'solidprinciples',

  // ── Version Control & Collaboration ────────────────────────────────
  'gh': 'github',
  'gl': 'gitlab',
  'svn': 'subversion',
  'hg': 'mercurial',

  // ── Networking & Infrastructure ────────────────────────────────────
  'cdn': 'cdn',
  'vpn': 'vpn',
  'dns': 'dns',
  'lb': 'loadbalancing',  'loadbalancer': 'loadbalancing',

  // ── ERP / CRM / Business Systems ──────────────────────────────────
  'sfdc': 'salesforce',
  'erp': 'erp',
  'crm': 'crm',
  'sap': 'sap',

  // ── Design & UX ────────────────────────────────────────────────────
  'ui': 'userinterface',
  'ux': 'userexperience',
  'uiux': 'uiux',
  'adobexd': 'adobexd',  'xd': 'adobexd',

  // ── Operating Systems ──────────────────────────────────────────────
  'rhel': 'redhat',  'redhatenterpriselinux': 'redhat',
  'osx': 'macos',    'macosx': 'macos', 'macintosh': 'macos',
  'win': 'windows',  'windowsserver': 'windows',

  // ── Blockchain / Web3 ──────────────────────────────────────────────
  'web3js': 'web3',
  'ethersjs': 'ethers',
  'defi': 'decentralizedfinance',
  'smartcontract': 'smartcontracts',
  'ipfs': 'ipfs',
}

export function normalizeSkill(s: string): string {
  const lower = s.toLowerCase().trim()
  if (SYMBOL_LANGS[lower] !== undefined) return SYMBOL_LANGS[lower]
  const n = lower
    .replace(/\.js\b/gi, '')
    .replace(/[\s\-_./]+/g, '')
  return SKILL_ALIASES[n] ?? n
}

export const NOISE_SUFFIXES = [
  'developers', 'developer',
  'programmers', 'programmer', 'programming', 'programing',
  'engineers', 'engineer', 'engineering',
  'development',
  'languages', 'language',
  'frameworks', 'framework',
  'libraries', 'library',
  'experience', 'skills', 'skill',
  'expertise', 'proficiency', 'knowledge',
  'concepts', 'concept', 'fundamentals', 'basics',
  'applications', 'application',
  'services', 'service',
  'pipelines', 'pipeline',
]

export function normalizeDeep(s: string): string {
  const versionStripped = s.replace(/\s+v?\d+(\.\d+)*(x|\+)?/gi, '').trim()
  let n = normalizeSkill(versionStripped)
  for (const suf of NOISE_SUFFIXES) {
    if (n.endsWith(suf) && n.length > suf.length + 2) {
      n = n.slice(0, n.length - suf.length)
      break
    }
  }
  return n
}

export function splitCompound(s: string): string[] {
  return s.split(/\s*[/,;&|+]\s*/).map(p => p.trim()).filter(p => p.length > 0)
}

export function skillsMatch(userSkill: string, jdSkill: string): boolean {
  if (normalizeSkill(userSkill) === normalizeSkill(jdSkill)) return true
  const nu = normalizeDeep(userSkill), nj = normalizeDeep(jdSkill)
  if (nu === nj && nu.length >= 3) return true
  const jdParts = splitCompound(jdSkill)
  if (jdParts.length > 1 && jdParts.some(p => normalizeDeep(userSkill) === normalizeDeep(p))) return true
  const userParts = splitCompound(userSkill)
  if (userParts.length > 1 && userParts.some(p => normalizeDeep(p) === nj)) return true
  return false
}

// ── Match scoring ─────────────────────────────────────────────────────────────
export interface SkillEntry {
  skill: string
  has: boolean
}

export interface MatchResult {
  match_score: number
  // Categorized (for candidate-facing UI)
  required: SkillEntry[]
  preferred: SkillEntry[]
  nice_to_have: SkillEntry[]
  // Flat arrays (backward compat with talent search response)
  matched_skills: string[]
  missing_skills: string[]
  // Experience
  experience_years_candidate: number
  experience_years_required: number | null
}

// Score breakdown:
//   Skills: 60pts (with exp requirement) / 75pts (without)
//   Experience: 15pts (only when required_experience_years is set)
//   Semantic: 23pts
//   Total max: 98
export function computeMatchScore(
  rawSimilarity: number,
  userSkills: string[],
  jdSkills: CategorizedSkills,
  candidateExperienceYears = 0,
): MatchResult {
  const safe = userSkills ?? []

  const toEntries = (skills: string[]): SkillEntry[] =>
    skills.map(skill => ({ skill, has: safe.some(u => skillsMatch(u, skill)) }))

  const requiredEntries = toEntries(jdSkills.required)
  const preferredEntries = toEntries(jdSkills.preferred)
  const niceToHaveEntries = toEntries(jdSkills.nice_to_have)

  const hasAnySkills = requiredEntries.length + preferredEntries.length + niceToHaveEntries.length > 0

  // Flat arrays for backward compat with talent search response and explanations endpoint
  const allEntries = [...requiredEntries, ...preferredEntries, ...niceToHaveEntries]
  const matched_skills = allEntries.filter(e => e.has).map(e => e.skill)
  const missing_skills = allEntries.filter(e => !e.has).map(e => e.skill)

  // Semantic component
  const semScore = Math.min(Math.max((rawSimilarity - 0.15) / 0.30, 0), 1)

  // Experience component: 15pts only when requirement is specified
  const req_years = jdSkills.required_experience_years
  const hasExpRequirement = req_years != null
  let expPoints = 0
  if (hasExpRequirement) {
    expPoints = req_years === 0 ? 15 : Math.min(candidateExperienceYears / req_years, 1) * 15
  }

  // Skills component: weighted by category importance
  const skillsMaxPts = hasExpRequirement ? 60 : 75
  let skillPoints = 0
  if (hasAnySkills) {
    const WEIGHTS = { required: 3, preferred: 1, nice_to_have: 0.3 } as const
    const totalWeight =
      requiredEntries.length * WEIGHTS.required +
      preferredEntries.length * WEIGHTS.preferred +
      niceToHaveEntries.length * WEIGHTS.nice_to_have
    if (totalWeight > 0) {
      const matchedWeight =
        requiredEntries.filter(e => e.has).length * WEIGHTS.required +
        preferredEntries.filter(e => e.has).length * WEIGHTS.preferred +
        niceToHaveEntries.filter(e => e.has).length * WEIGHTS.nice_to_have
      skillPoints = (matchedWeight / totalWeight) * skillsMaxPts
    }
  }

  let match_score: number
  if (!hasAnySkills) {
    match_score = Math.round(semScore * 98)
  } else {
    match_score = Math.min(Math.round(skillPoints + expPoints + semScore * 23), 98)
  }

  return {
    match_score,
    required: requiredEntries,
    preferred: preferredEntries,
    nice_to_have: niceToHaveEntries,
    matched_skills,
    missing_skills,
    experience_years_candidate: candidateExperienceYears,
    experience_years_required: req_years ?? null,
  }
}
