import { App } from 'aws-cdk-lib';
import { KmsStack } from './kms-stack';

const app = new App();

new KmsStack(app, 'KmsStack');

app.synth();