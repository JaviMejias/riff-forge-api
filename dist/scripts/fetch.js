"use strict";
async function search() {
    const metaRes = await fetch('https://archive.org/metadata/gtptabs');
    const meta = await metaRes.json();
    console.log(meta.files.map((f) => f.name));
}
search();
