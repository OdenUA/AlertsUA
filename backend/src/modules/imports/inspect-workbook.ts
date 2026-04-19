import { ImportsService } from './imports.service';

async function main() {
  const service = new ImportsService();
  const info = await service.inspectWorkbook(process.argv[2]);
  console.log(JSON.stringify(info, null, 2));
}

void main();
