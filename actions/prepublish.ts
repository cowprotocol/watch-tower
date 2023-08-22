import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';

const url = 'https://raw.githubusercontent.com/cowprotocol/composable-cow/8c762559c98b707801f52dd070dd39ab9478b876/out/ComposableCoW.sol/ComposableCoW.json';
const abiDir = path.join(__dirname, 'abi');
const targetFile = path.join(abiDir, 'ComposableCoW.json');

if (!fs.existsSync(abiDir)) {
  fs.mkdirSync(abiDir);
}

const fileStream = fs.createWriteStream(targetFile);

https.get(url, (response) => {
  response.pipe(fileStream);
  fileStream.on('finish', () => {
    fileStream.close();
    console.log('File downloaded and saved successfully.');
  });
}).on('error', (error) => {
  console.error('Error downloading the file:', error);
});
