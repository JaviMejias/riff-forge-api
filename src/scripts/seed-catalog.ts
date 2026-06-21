/// <reference types="node" />
import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import * as util from 'util';
import * as crypto from 'crypto';
import AdmZip from 'adm-zip';

const execPromise = util.promisify(exec);
const prisma = new PrismaClient();

const CATALOG_DIR = path.join(__dirname, '../../data/catalog');

async function downloadAndExtract() {
  if (!fs.existsSync(CATALOG_DIR)) {
    fs.mkdirSync(CATALOG_DIR, { recursive: true });
  }

  const zipPath = path.join(CATALOG_DIR, 'catalog.zip');

  if (!fs.existsSync(zipPath)) {
    console.log('Fetching archive metadata...');
    const metaRes = await fetch('https://archive.org/metadata/gtptabs');
    const meta = await metaRes.json();
    const zipFile = meta.files.find((f: any) => f.name.endsWith('.zip') && !f.name.includes('sqlite'));
    if (!zipFile) {
        console.error('Available files:', meta.files.map((f: any) => f.name));
        throw new Error('Could not find ZIP file in archive');
    }

    const downloadUrl = `https://archive.org/download/gtptabs/${zipFile.name}`;
    console.log(`Downloading ${downloadUrl}...`);
    
    await execPromise(`curl -L -o "${zipPath}" "${downloadUrl}"`);
    console.log('Download complete.');
  } else {
    console.log('ZIP already downloaded.');
  }

  const extractDir = path.join(CATALOG_DIR, 'extracted');
  if (!fs.existsSync(extractDir)) {
    console.log('Extracting ZIP using adm-zip...');
    fs.mkdirSync(extractDir, { recursive: true });
    
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(extractDir, true);
    
    console.log('Extraction complete.');
  } else {
    console.log('Already extracted.');
  }

  return extractDir;
}

// Recursively find all .gp files, and extract any inner .zip files we encounter
async function walkDir(dir: string, fileList: string[] = []) {
  const files = await fs.promises.readdir(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = await fs.promises.stat(filePath);
    
    if (stat.isDirectory()) {
      await walkDir(filePath, fileList);
    } else {
      const ext = path.extname(file).toLowerCase();
      
      // If it's a nested zip, extract it and then walk its new directory
      if (ext === '.zip') {
        const innerExtractDir = filePath.substring(0, filePath.length - 4); // Remove .zip
        if (!fs.existsSync(innerExtractDir)) {
          fs.mkdirSync(innerExtractDir, { recursive: true });
          try {
            console.log(`Extracting inner zip: ${file}`);
            const zip = new AdmZip(filePath);
            zip.extractAllTo(innerExtractDir, true);
          } catch (e) {
            console.error(`Failed to extract ${file}`, e);
          }
        }
        // Delete the zip to save space
        fs.unlinkSync(filePath);
        // Walk the newly extracted folder
        await walkDir(innerExtractDir, fileList);
      } 
      else if (['.gp3', '.gp4', '.gp5', '.gpx', '.gp'].includes(ext)) {
        fileList.push(filePath);
      }
    }
  }
  return fileList;
}

async function seed() {
  try {
    const extractDir = await downloadAndExtract();
    
    console.log('Scanning for Guitar Pro files...');
    const allFiles = await walkDir(extractDir);
    console.log(`Found ${allFiles.length} files. Indexing to database...`);

    console.log('Clearing old catalog entries...');
    await prisma.catalogTab.deleteMany({});

    const batchSize = 1000;
    let batch = [];
    let count = 0;

    for (const filePath of allFiles) {
      const parts = filePath.split(path.sep);
      const fileName = parts.pop() || '';
      const parentDir = parts.pop() || 'Unknown Artist';
      
      let artist = parentDir;
      if (artist.toLowerCase() === 'gp5' || artist.length <= 1) {
          artist = 'Unknown Artist';
      }

      const title = path.basename(fileName, path.extname(fileName)).replace(/[-_]/g, ' ');
      const format = path.extname(fileName).replace('.', '');
      const relPath = path.relative(path.join(__dirname, '../../data'), filePath);

      batch.push({
        id: crypto.randomUUID(),
        artist,
        title,
        format,
        filePath: relPath
      });

      if (batch.length >= batchSize) {
        await prisma.catalogTab.createMany({ data: batch });
        count += batch.length;
        console.log(`Indexed ${count} / ${allFiles.length}...`);
        batch = [];
      }
    }

    if (batch.length > 0) {
      await prisma.catalogTab.createMany({ data: batch });
      count += batch.length;
    }

    console.log(`Successfully indexed ${count} tabs into the Global Catalog.`);

  } catch (error) {
    console.error('Error during seeding:', error);
  } finally {
    await prisma.$disconnect();
  }
}

seed();
