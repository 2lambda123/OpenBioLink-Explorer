'use strict';

const axios = require('axios');
const fs = require('fs');
var FormData = require('form-data');
const {tic, toc, variables}  = require('./util');

//const endpoint = "http://localhost:3030"

async function runSPARQL(endpoint, query){
    console.log(query);
    var response = await axios({
        method: 'post',
        setTimeout: 6000,
        headers: {"Content-type": "application/x-www-form-urlencoded"},
        url: endpoint,
        data: query
    });
    var data = await response.data;
    return data;
}

let graph_label = {
    getAllTestEntities(endpoint, namespace, callback){

        var query = `query=
                PREFIX obl:  <http://ai-strategies.org/ns/>
                SELECT ?value ?label (GROUP_CONCAT(?type;SEPARATOR=",") AS ?types)
                WHERE { 
                {
                    SELECT distinct ?value ?label 
                    WHERE {{ 
                    <<?value ?p ?o>> obl:split obl:test .
                    } UNION { 
                    <<?s ?p ?value>> obl:split obl:test .
                    }}
                }
                OPTIONAL{ ?value <http://www.w3.org/2000/01/rdf-schema#label> ?label .}
                OPTIONAL{ ?value a ?type .}
                }
                GROUP BY ?value ?label
            `
        runSPARQL(endpoint, query).then((data) => {
            var entities = data["results"]["bindings"].map((x) => {return {NAME: x["value"]["value"].replace(namespace, ''), Label: x["label"]?.value, Types: x["types"]?.value.split(",")}})
            var query = `query=
                SELECT distinct ?type
                WHERE { 
                ?s a ?type
                }
                ORDER BY ?type
            `
            runSPARQL(endpoint, query).then((data) => {
                var types = data["results"]["bindings"].map((x) => x["type"].value);
                callback(entities, types);
            });
        });
    },
    addLabelsToPredictions(endpoint, namespace, predictions, callback){
        var query = `query=
            prefix ns: <${namespace}>
            SELECT ?subject ?object
            WHERE {
                ?subject <http://www.w3.org/2000/01/rdf-schema#label> ?object
                VALUES ?subject {
                    ${predictions.map((elem)=>{return "ns:" + elem["EntityName"].replace(/\//g,"\\/")}).join(" ")}
                }
            }
            `;
        runSPARQL(endpoint, query).then((data) => {
            var label_map = {};
            for(var i = 0; i < data["results"]["bindings"].length; i++){
                var triple = data["results"]["bindings"][i];
                label_map[triple["subject"]["value"].replace(namespace, '')] = triple["object"]["value"]
            }
            for(var i = 0; i < predictions.length; i++){
                predictions[i].Label = label_map[predictions[i]["EntityName"]];
            }
            callback(predictions);
        });
    },
    addLabelsToExplanations(endpoint, namespace, groups, variables, entities, callback){
        var query = `query=
            prefix ns: <${namespace}>
            SELECT ?subject ?object
            WHERE {
                ?subject <http://www.w3.org/2000/01/rdf-schema#label> ?object
                VALUES ?subject {
                    ${[...entities].map((elem)=>{return "ns:" + elem.replace(/\//g,"\\/")}).join(" ")}
                }
            }
            `
        runSPARQL(endpoint, query).then((data) => {
            var label_map = {};
            for(var i = 0; i < data["results"]["bindings"].length; i++){
                var triple = data["results"]["bindings"][i];
                label_map[triple["subject"]["value"].replace(namespace, '')] = triple["object"]["value"]
            }
            groups.forEach((element) => {
                element.Rules.forEach((rule) => {
                    if(!(variables.includes(rule.Definition.head))){
                        rule.Definition.headLabel = label_map[rule.Definition.head];
                    }
                    if(!(variables.includes(rule.Definition.tail))){
                        rule.Definition.tailLabel = label_map[rule.Definition.tail];
                    }
                    rule.Definition.bodies.forEach((body)=>{
                        if(!(variables.includes(body.head))){
                            body.headLabel = label_map[body.head];
                        }
                        if(!(variables.includes(body.tail))){
                            body.tailLabel = label_map[body.tail];
                        }
                    })
                })
            });
            callback(groups);
        });
    },
    getInfoByCurie(endpoint, namespace, curie, callback){
        var query = `query=
            SELECT ?label ?comment
            WHERE {
                <${namespace}${curie}> <http://www.w3.org/2000/01/rdf-schema#label> ?label .
                OPTIONAL {<${namespace}${curie}> <http://www.w3.org/2000/01/rdf-schema#comment> ?comment .}
            }
            `

        runSPARQL(endpoint, query).then((data) => {
            var edge = data["results"]["bindings"][0];
            var res = {
                Label: edge?.label?.value,
                Description: edge?.comment?.value,
                Synonyms: [],
                Labels: [],
                Curie: curie
            }

            var query = `query=
            SELECT ?synonym
            WHERE {
                OPTIONAL {<${namespace}${curie}> <http://www.geneontology.org/formats/oboInOwl#hasExactSynonym> ?synonym .}
            }`
            runSPARQL(endpoint, query).then((data) => {
                if(Object.entries(data["results"]["bindings"][0]).length > 0){
                    for(var i = 0; i < data["results"]["bindings"].length; i++){
                        var edge = data["results"]["bindings"][i];
                        res.Synonyms.push(edge["synonym"]["value"]);
                    }
                }

                var query = `query=
                    SELECT ?label
                    WHERE {
                        OPTIONAL {<${namespace}${curie}> a ?label .}
                    }`
                runSPARQL(endpoint, query).then((data) => {
                    if(Object.entries(data["results"]["bindings"][0]).length > 0){
                        for(var i = 0; i < data["results"]["bindings"].length; i++){
                            var edge = data["results"]["bindings"][i];
                            res.Labels.push(edge["label"]["value"]);
                        }
                    }
                    callback(res);
                });
            });
        });
    },
    getOutgoingEdges(endpoint, namespace, curie, callback){
        var res = new Proxy({}, {get(target, name){
            if(name === "toJSON" || name === "then"){
                return undefined;
            } else if(!target.hasOwnProperty(name)){
                target[name] = []
            }
            return target[name]
        }});

        var query = `query=
            PREFIX obl:  <http://ai-strategies.org/ns/>
            SELECT ?predicate ?object ?label
            WHERE {
                <<<${namespace}${curie}> ?predicate ?object>> obl:split obl:train .
                OPTIONAL{ ?object <http://www.w3.org/2000/01/rdf-schema#label> ?label .}
            }
            `
        runSPARQL(endpoint, query).then((data) => {
            if(data["results"]["bindings"].length > 0 && Object.entries(data["results"]["bindings"][0]).length > 0){
                for(var i = 0; i < data["results"]["bindings"].length; i++){
                    var edge = data["results"]["bindings"][i];
                    res[edge["predicate"]["value"].replace(namespace, '')].push([edge["label"]?.value, edge["object"]["value"].replace(namespace, '')]);
                }   
            }           
            callback(res);
        });
    },
    getIncomingEdges(endpoint, namespace, curie, callback){
        var res = new Proxy({}, {get(target, name){
            if(name === "toJSON" || name === "then"){
                return undefined;
            } else if(!target.hasOwnProperty(name)){
                target[name] = []
            }
            return target[name]
        }});

        var query = `query=
            PREFIX obl:  <http://ai-strategies.org/ns/>
            SELECT ?subject ?predicate ?label
            WHERE {
                <<?subject ?predicate <${namespace}${curie}>>> obl:split obl:train .
                OPTIONAL{ ?subject <http://www.w3.org/2000/01/rdf-schema#label> ?label .}
            }
            `
        runSPARQL(endpoint, query).then((data) => {
            for(var i = 0; i < data["results"]["bindings"].length; i++){
                var edge = data["results"]["bindings"][i];
                res[edge["predicate"]["value"].replace(namespace, '')].push([edge["label"]["value"], edge["subject"]["value"].replace(namespace, '')]);
            }
            callback(res);
        });
    },
    getInstantiations(endpoint, namespace, head, tail, rule, callback){
        var used_variables = new Set();

        function getEntity(entity){
            if(!variables.includes(entity)){
                return "<" + namespace + entity + ">";
            } else if(entity === "X"){
                return "<" + namespace + head + ">";
            } else if(entity === "Y") {
                return "<" + namespace + tail + ">";
            } else {
                used_variables.add(entity);
                return "?" + entity + "_"
            }
        }
        function getRelation(relation){
            return "<" + namespace + relation + ">";
        }

        var where = "";
        rule.bodies.forEach((element) => {
            where = where + "<<" + getEntity(element.head) + " " + getRelation(element.relation) + " " + getEntity(element.tail) + ">> obl:split obl:train . \n";
        });

        used_variables.forEach((element) => {
            where = where + "OPTIONAL { ?" + element + "_ <http://www.w3.org/2000/01/rdf-schema#label> " + "?" + element + " . }\n"
        });

        var query = `query=
            PREFIX obl:  <http://ai-strategies.org/ns/>
            SELECT ${[...used_variables].map(x => "?" + x).join(" ")} ${[...used_variables].map(x => "?" + x + "_").join(" ")}
            WHERE {
                ${where}
            }
        `
        runSPARQL(endpoint, query).then((data) => {
            var res = [];
            for(var i = 0; i < data["results"]["bindings"].length; i++){
                var edge = data["results"]["bindings"][i];
                var instantiation = [];
                used_variables.forEach((element) => {
                    var variable = {};
                    variable.variable = element;
                    variable.label = edge[element]?.value;
                    variable.curie = edge[element + "_"]["value"].replace(namespace, '');
                    instantiation.push(variable);
                });
                res.push(instantiation);
            }
            //callback(data["results"]["bindings"])
            callback(res);
        });
    }
}

exports.graph_label = graph_label;