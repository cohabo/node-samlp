var saml20                = require('saml').Saml20;
var SignedXml             = require('xml-crypto').SignedXml;
var xpath                 = require('xpath');
var xtend                 = require('xtend');
var utils                 = require('./utils');
var templates             = require('./templates');
var encoders              = require('./encoders');
var PassportProfileMapper = require('./claims/PassportProfileMapper');
var constants             = require('./constants');

function buildSamlResponse(options) {
	var SAMLResponse = templates.samlresponse({
		id:             '_' + utils.generateUniqueID(),
		instant:        utils.generateInstant(),
		destination:    options.destination || options.audience,
		inResponseTo:   options.inResponseTo,
		issuer:         options.issuer,
		samlStatusCode: options.samlStatusCode,
		samlStatusMessage: options.samlStatusMessage,
		assertion:      options.signedAssertion || ''
	});

	if (options.signResponse) {
		options.signatureNamespacePrefix = typeof options.signatureNamespacePrefix === 'string' ? options.signatureNamespacePrefix : '' ;

		var cannonicalized = SAMLResponse
			.replace(/\r\n/g, '')
			.replace(/\n/g,'')
			.replace(/>(\s*)</g, '><') //unindent
			.trim();

		var sig = new SignedXml(null, {
			signatureAlgorithm: constants.ALGORITHMS.SIGNATURE[options.signatureAlgorithm],
			idAttribute: 'ID'
		});

		sig.addReference(
			constants.ELEMENTS.RESPONSE.SIGNATURE_LOCATION_PATH,
			["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"],
			constants.ALGORITHMS.DIGEST[options.digestAlgorithm]);

		sig.signingKey = options.key;

		var pem = encoders.removeHeaders(options.cert);
		sig.keyInfoProvider = {
			getKeyInfo: function (key, prefix) {
				prefix = prefix ? prefix + ':' : prefix;
				return "<" + prefix + "X509Data><" + prefix + "X509Certificate>" + pem + "</" + prefix + "X509Certificate></" + prefix + "X509Data>";
			}
		};

		sig.computeSignature(cannonicalized, { prefix: options.signatureNamespacePrefix });
		SAMLResponse = sig.getSignedXml();
	}

	return SAMLResponse;
}

function  getSamlResponse(options, user, callback) {
	options.profileMapper = options.profileMapper || PassportProfileMapper;
	options.signatureNamespacePrefix = typeof options.signatureNamespacePrefix === 'string' ? options.signatureNamespacePrefix : '' ;

	var profileMap = options.profileMapper(user);
	var claims = profileMap.getClaims(options);
	var ni = profileMap.getNameIdentifier(options);

	if (!ni || !ni.nameIdentifier) {
		var error = new Error('No attribute was found to generate the nameIdentifier. We tried with: ' + (options.nameIdentifierProbes || []).join(', '));
		error.context = { user: user };
		return callback(error);
	}

	saml20.create({
		signatureAlgorithm:   options.signatureAlgorithm,
		digestAlgorithm:      options.digestAlgorithm,
		cert:                 options.cert,
		key:                  options.key,
		issuer:               options.issuer,
		lifetimeInSeconds:    options.lifetimeInSeconds || 3600,
		audiences:            options.audience,
		attributes:           options.attributes?Object.assign(claims,options.attributes):claims,
		nameIdentifier:       ni.nameIdentifier,
		nameIdentifierFormat: ni.nameIdentifierFormat || options.nameIdentifierFormat,
		recipient:            options.recipient,
		inResponseTo:         options.inResponseTo,
		authnContextClassRef: options.authnContextClassRef,
		encryptionPublicKey:  options.encryptionPublicKey,
		encryptionCert:       options.encryptionCert,
		sessionIndex:         options.sessionIndex,
		typedAttributes:      options.typedAttributes,
		includeAttributeNameFormat:    options.includeAttributeNameFormat,
		signatureNamespacePrefix:      options.signatureNamespacePrefix,
		nameQualifier:        options.nameQualifier,
        spNameQualifier:      options.spNameQualifier,
		persistentId:         options.persistentId
	}, function (err, signedAssertion) {
		if (err) return callback(err);

		options.signedAssertion = signedAssertion;
		options.samlStatusCode = options.samlStatusCode || constants.STATUS.SUCCESS;
		var SAMLResponse = buildSamlResponse(options);
		callback(null, SAMLResponse);
	});
}

/**
 * SAML Protocol middleware.
 *
 * This middleware creates a SAML endpoint based on the user logged in identity.
 *
 * options:
 * - profileMapper(profile) a ProfileMapper implementation to convert a user profile to claims  (PassportProfile).
 * - getUserFromRequest(req) a function that given a request returns the user. By default req.user
 * - issuer string
 * - cert the public certificate
 * - key the private certificate to sign all tokens
 * - postUrl function (SAMLRequest, request, callback)
 * - responseHandler(SAMLResponse, options, request, response, next) a function that handles the response. Defaults to HTML POST to postUrl.
 * - customResponseHandler
 * @param  {[type]} options [description]
 * @return {[type]}         [description]
 */
module.exports.auth = function(options) {
	options.getUserFromRequest = options.getUserFromRequest || function(req){ return req.user; };
	options.signatureAlgorithm = options.signatureAlgorithm || 'rsa-sha256';
	options.digestAlgorithm = options.digestAlgorithm || 'sha256';

	if (typeof options.getPostURL !== 'function') {
		throw new Error('getPostURL is required');
	}

	return function (req, res, next) {
		req = req || {};
		res = res || {};
		next = next || null;
		var opts = xtend({}, options || {}); // clone options

		if(!opts.customResponseHandler && req.method === 'GET' && req.query.Signature){
			opts.signature = req.query.Signature;
			opts.sigAlg = req.query.SigAlg;
			opts.relayState = opts.RelayState || req.query.RelayState;
		}

		function execute (postUrl, audience, req, res, next) {
			var user = opts.getUserFromRequest(req || opts);
			if (!user) return opts.customResponseHandler? opts.customResponseHandler(401, null):res.send(401);

			opts.audience = audience;
			opts.postUrl = postUrl;

			getSamlResponse(opts, user, function (err, SAMLResponse) {
				if (err) return opts.customResponseHandler?opts.customResponseHandler(err, null):next(err);

				var response = new Buffer(SAMLResponse);
				console.log(SAMLResponse);
				if (opts.responseHandler) {
					opts.responseHandler(response, opts, req, res, next);
				}
				else if(opts.customResponseHandler){
					let lclTemplate = opts.template?templates.processEjsTemplate(opts.template):templates.form;

					return opts.customResponseHandler(null, lclTemplate({
						type:            'SAMLResponse',
						callback:        postUrl,
						RelayState:      opts.RelayState || '',
						token:           opts.plainXml?SAMLResponse:response.toString('base64')
					}));
				}
				else {
					res.set('Content-Type', 'text/html');
					res.send(templates.form({
						type:            'SAMLResponse',
						callback:        postUrl,
						RelayState:      opts.RelayState || (req.query || {}).RelayState || (req.body || {}).RelayState || '',
						token:           response.toString('base64')
					}));
				}
			});
		}

		if(opts.customResponseHandler)
			execute(opts.getPostURL(), opts.audience);
		else
			utils.parseSamlRequest(req, (req.query || {}).SAMLRequest || (req.body || {}).SAMLRequest,  "AUTHN_REQUEST", opts, function(err, samlRequestDom) {
				if (err) return next(err);

				var audience = opts.audience;
				if (samlRequestDom) {
					if (!audience){
						var issuer = xpath.select("//*[local-name(.)='Issuer' and namespace-uri(.)='urn:oasis:names:tc:SAML:2.0:assertion']/text()", samlRequestDom);
						if (issuer && issuer.length > 0)
							audience = issuer[0].textContent;
					}

					var id = samlRequestDom.documentElement.getAttribute('ID');
					if (id) opts.inResponseTo = opts.inResponseTo || id;
				}

				opts.getPostURL(audience, samlRequestDom, req, function (err, postUrl) {
					if (err) { return res.send(500, err); }
					if (!postUrl) { return res.send(401); }

					execute(postUrl, audience, req, res, next);
				});
			});
	};
};

module.exports.parseRequest = function(req, options, callback) {
	if (typeof options === 'function'){
		callback = options;
		options = {};
	}

	var samlRequest = (req.query || {}).SAMLRequest || (req.body || {}).SAMLRequest;
	if (!samlRequest){
		callback('No samlRequest to process');
		return;
	}


	utils.parseSamlRequest(req, samlRequest,  "AUTHN_REQUEST", options, function(err, samlRequestDom) {
		if (err) {
			callback(err);
			return;
		}

		var data = {};
		var issuer = xpath.select("//*[local-name(.)='Issuer' and namespace-uri(.)='urn:oasis:names:tc:SAML:2.0:assertion']/text()", samlRequestDom);
		if (issuer && issuer.length > 0) data.issuer = issuer[0].textContent;

		var assertionConsumerUrl = samlRequestDom.documentElement.getAttribute('AssertionConsumerServiceURL');
		if (assertionConsumerUrl) data.assertionConsumerServiceURL = assertionConsumerUrl;

		var destination = samlRequestDom.documentElement.getAttribute('Destination');
		if (destination) data.destination = destination;

		var forceAuthn = samlRequestDom.documentElement.getAttribute('ForceAuthn');
		if (forceAuthn) data.forceAuthn = forceAuthn;

		var id = samlRequestDom.documentElement.getAttribute('ID');
		if (id) data.id = id;

		var requestedAuthnContextClassRefElements = xpath.select(constants.ELEMENTS.AUTHN_REQUEST.AUTHN_CONTEXT_CLASS_REF_PATH, samlRequestDom)

		if (requestedAuthnContextClassRefElements && requestedAuthnContextClassRefElements.length === 1) {
			data.requestedAuthnContext = {};

			data.requestedAuthnContext.authnContextClassRef = requestedAuthnContextClassRefElements[0].textContent;
		}

		callback(null, data);
	});
};

module.exports.getSamlResponse = getSamlResponse;

module.exports.sendError = function (options) {
	// https://docs.oasis-open.org/security/saml/v2.0/saml-core-2.0-os.pdf
	function renderResponse(res, postUrl) {
		var error = options.error || {};
		options.samlStatusCode = error.code || constants.STATUS.RESPONDER;
		options.samlStatusMessage = error.description;

		var SAMLResponse = buildSamlResponse(options);
		var response = new Buffer(SAMLResponse);

		res.set('Content-Type', 'text/html');
		res.send(templates.form({
			type:         'SAMLResponse',
			callback:     postUrl,
			RelayState:   options.RelayState,
			token:        response.toString('base64')
		}));
	}

	return function (req, res, next) {
		options.getPostURL(req, function (err, postUrl) {
			if (err) return next(err);
			if (!postUrl) return next(new Error('postUrl is required'));
			renderResponse(res, postUrl);
		});
	};
};
