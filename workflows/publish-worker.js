// Cloudflare Worker: receives an uploaded spreadsheet from the "Publish for
// everyone" button on the map page, checks a shared PIN, and commits it to
// the DGS LIST.xlsx file in the GitHub repo via GitHub's Contents API.
// GitHub Actions then picks up that commit exactly like a normal push and
// runs the geocode cache update automatically — this Worker doesn't need
// to know anything about geocoding.
//
// Required secrets (Settings -> Variables and Secrets on this Worker):
//   GITHUB_TOKEN  - fine-grained PAT, Contents: Read and write, scoped to
//                   just the Cha-NPE/Taranaki-DG-Map repo
//   PUBLISH_PIN   - shared PIN colleagues enter before publishing

const OWNER = 'Cha-NPE';
const REPO = 'Taranaki-DG-Map';
const FILE_PATH = 'DGS LIST.xlsx';
const ALLOWED_ORIGIN = 'https://cha-npe.github.io'; // GitHub Pages origin for this repo

function corsHeaders(){
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Publish-Pin',
  };
}

function jsonResponse(body, status){
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
  });
}

function arrayBufferToBase64(buffer){
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000; // avoid call-stack limits on String.fromCharCode for large files
  for (let i = 0; i < bytes.length; i += chunkSize){
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export default {
  async fetch(request, env){
    if (request.method === 'OPTIONS'){
      return new Response(null, { headers: corsHeaders() });
    }

    if (request.method !== 'POST'){
      return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    const pin = request.headers.get('X-Publish-Pin') || '';
    if (!env.PUBLISH_PIN || pin !== env.PUBLISH_PIN){
      return jsonResponse({ error: 'Incorrect PIN' }, 401);
    }

    let fileBuffer;
    try {
      fileBuffer = await request.arrayBuffer();
    } catch (e){
      return jsonResponse({ error: 'Could not read uploaded file' }, 400);
    }

    if (!fileBuffer || fileBuffer.byteLength === 0){
      return jsonResponse({ error: 'No file received' }, 400);
    }

    // A real .xlsx is a zip archive and starts with the bytes "PK" — catches
    // a corrupted upload before it overwrites the repo's spreadsheet.
    const header = new Uint8Array(fileBuffer.slice(0, 2));
    if (header[0] !== 0x50 || header[1] !== 0x4b){
      return jsonResponse({ error: 'File does not look like a valid .xlsx spreadsheet' }, 400);
    }

    const apiUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(FILE_PATH)}`;
    const ghHeaders = {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'dg-map-publish-worker',
      'X-GitHub-Api-Version': '2022-11-28'
    };

    // Need the current file's SHA to update it (GitHub's API requires this
    // for edits to an existing file, not for creating a brand new one).
    let sha;
    const getRes = await fetch(apiUrl, { headers: ghHeaders });
    if (getRes.status === 200){
      sha = (await getRes.json()).sha;
    } else if (getRes.status !== 404){
      return jsonResponse({ error: 'Could not check existing file on GitHub', detail: await getRes.text() }, 502);
    }

    const commitBody = {
      message: 'Publish spreadsheet update via web page',
      content: arrayBufferToBase64(fileBuffer),
      committer: { name: 'DG Map Publisher', email: 'actions@users.noreply.github.com' }
    };
    if (sha) commitBody.sha = sha;

    const putRes = await fetch(apiUrl, {
      method: 'PUT',
      headers: { ...ghHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(commitBody)
    });

    if (!putRes.ok){
      return jsonResponse({ error: 'GitHub commit failed', detail: await putRes.text() }, 502);
    }

    return jsonResponse({ ok: true }, 200);
  }
};
