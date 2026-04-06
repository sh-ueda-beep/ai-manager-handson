---
title: "Modify Amplify-generated Cognito resources with CDK"
section: "build-a-backend/auth"
platforms: ["android", "angular", "flutter", "javascript", "nextjs", "react", "react-native", "swift", "vue"]
gen: 2
last-updated: "2025-12-03T11:13:25.000Z"
url: "https://docs.amplify.aws/react/build-a-backend/auth/modify-resources-with-cdk/"
---

Amplify Auth provides sensible defaults for the underlying Amazon Cognito resource definitions. You can customize your authentication resource to enable it to behave exactly as needed for your use cases by modifying it directly using [AWS Cloud Development Kit (CDK)](https://aws.amazon.com/cdk/)

## Override Cognito UserPool password policies

You can override the password policy by using the L1 `cfnUserPool` construct and adding a `addPropertyOverride`.

```ts title="amplify/backend.ts"
import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource';

const backend = defineBackend({
  auth,
});
// extract L1 CfnUserPool resources
const { cfnUserPool } = backend.auth.resources.cfnResources;
// modify cfnUserPool policies directly
cfnUserPool.policies = {
  passwordPolicy: {
    minimumLength: 10,
    requireLowercase: true,
    requireNumbers: true,
    requireSymbols: true,
    requireUppercase: true,
    temporaryPasswordValidityDays: 20,
  },
};
```

<!-- Platform: android,angular, javascript, nextjs, react, react-native, swift, vue -->
## Override Cognito UserPool to enable passwordless sign-in methods

> **Info:** **Recommended approach:** Passwordless authentication can now be configured directly in `defineAuth` without requiring CDK overrides. [Learn how to configure passwordless authentication](/[platform]/build-a-backend/auth/concepts/passwordless/).

For advanced use cases, you can still modify the underlying Cognito user pool resource to enable sign in with passwordless methods using CDK overrides. [Learn more about passwordless sign-in methods](/[platform]/build-a-backend/auth/concepts/passwordless/). 

You can also read more about how passwordless authentication flows are implemented in the [Cognito documentation](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-authentication-flow-methods.html).

```ts title="amplify/backend.ts"
import { defineBackend } from "@aws-amplify/backend"
import { auth } from "./auth/resource"

const backend = defineBackend({
  auth,
})

const { cfnResources } = backend.auth.resources;
const { cfnUserPool, cfnUserPoolClient } = cfnResources;

// Specify which authentication factors you want to allow with USER_AUTH
cfnUserPool.addPropertyOverride(
	'Policies.SignInPolicy.AllowedFirstAuthFactors',
	['PASSWORD', 'WEB_AUTHN', 'EMAIL_OTP', 'SMS_OTP']
);

// The USER_AUTH flow is used for passwordless sign in
cfnUserPoolClient.explicitAuthFlows = [
	'ALLOW_REFRESH_TOKEN_AUTH',
	'ALLOW_USER_AUTH'
];

/* Needed for WebAuthn */
// The WebAuthnRelyingPartyID is the domain of your relying party, e.g. "example.domain.com"
cfnUserPool.addPropertyOverride('WebAuthnRelyingPartyID', '<RELYING_PARTY>');
cfnUserPool.addPropertyOverride('WebAuthnUserVerification', 'preferred');
```
<!-- /Platform -->
